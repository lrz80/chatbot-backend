// backend/src/lib/fastpath/runFastpath.ts
import type { Pool } from "pg";

import type { Canal } from "../detectarIntencion";
import type { Lang } from "../channels/engine/clients/clientDb";

import { traducirMensaje } from "../traducirMensaje";
import { traducirTexto } from "../traducirTexto";

// INFO_CLAVE includes
import { normalizeText } from "../infoclave/resolveIncludes";

// DB catalog includes
import { getServiceDetailsText } from "../services/resolveServiceInfo";

// Pricing
import { resolveServiceIdFromText } from "../services/pricing/resolveServiceIdFromText";
import { resolveBestLinkForService } from "../links/resolveBestLinkForService";
import { renderInfoGeneralOverview } from "../fastpath/renderInfoGeneralOverview";
import { getServiceAndVariantUrl } from "../services/getServiceAndVariantUrl";
import { buildCatalogContext } from "../catalog/buildCatalogContext";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export type FastpathCtx = {
  last_service_id?: string | null;
  last_service_name?: string | null;
  last_service_at?: number | null;

  pending_price_lookup?: boolean;
  pending_price_at?: number | null;

  // ✅ listas para selección posterior
  last_plan_list?: Array<{ id: string; name: string; url: string | null }>;
  last_plan_list_at?: number | null;

  last_package_list?: Array<{ id: string; name: string; url: string | null }>;
  last_package_list_at?: number | null;

  // ✅ señales estructurales (SIN COPY)
  has_packages_available?: boolean;
  has_packages_available_at?: number | null;

  last_list_kind?: "plan" | "package";
  last_list_kind_at?: number | null;

  pending_link_lookup?: boolean;
  pending_link_at?: number | null;
  pending_link_options?: Array<{ label: string; url: string }>;

  last_bot_action?: string | null;
  last_bot_action_at?: number | null;

  last_price_option_label?: string | null;
  last_price_option_at?: number | null;

  last_selected_kind?: "service" | "option" | "plan" | "package" | null;
  last_selected_id?: string | null;
  last_selected_name?: string | null;
  last_selected_at?: number | null;

  // ✅ histórico de planes listados por el motor de catálogo
  last_catalog_plans?: string[] | null;
  last_catalog_at?: number | null;

  // selección de servicio/variante para flujo "qué incluye"
  selectedServiceId?: string | null;
  expectingVariant?: boolean;

  [k: string]: any;
};

export type FastpathAwaitingEffect =
  | {
      type: "set_awaiting_yes_no";
      ttlSeconds: number;
      payload: any;
    }
  | { type: "none" };

export type FastpathHint =
  | {
      type: "price_summary";
      payload: {
        lang: Lang;
        rows: { service_name: string; min_price: number; max_price: number }[];
      };
    };

export type FastpathResult =
  | {
      handled: true;
      reply: string;
      source:
        | "service_list_db"
        | "info_clave_includes"
        | "info_clave_missing_includes"
        | "includes_fastpath_db"
        | "includes_fastpath_db_missing"
        | "includes_fastpath_db_ambiguous"
        | "price_disambiguation_db"
        | "price_missing_db"
        | "price_fastpath_db"
        | "price_summary_db"
        | "info_general_overview"
        | "price_summary_db_empty"
        | "info_clave_includes_ctx_link"
        | "interest_to_pricing"
        | "catalog_llm"
        | "fastpath_dismiss";
      intent: string | null;
      ctxPatch?: Partial<FastpathCtx>;
      awaitingEffect?: FastpathAwaitingEffect;
      fastpathHint?: FastpathHint;
    }
  | {
      handled: false;
      ctxPatch?: Partial<FastpathCtx>;
      fastpathHint?: FastpathHint;
    };

export type RunFastpathArgs = {
  pool: Pool;

  tenantId: string;
  canal: Canal;

  idiomaDestino: Lang;
  userInput: string;

  // Importante: el caller define si está en booking
  inBooking: boolean;

  // state context actual
  convoCtx: FastpathCtx;

  // multi-tenant: info_clave viene del tenant
  infoClave: string;

  // intent detectada (si existe) para logging/guardado
  detectedIntent?: string | null;

  // knobs
  maxDisambiguationOptions?: number; // default 5
  lastServiceTtlMs?: number; // default 60 min
};

async function answerCatalogQuestionLLM(params: {
  idiomaDestino: "es" | "en";
  systemMsg: string;
  userMsg: string;
}) {
  const { systemMsg, userMsg } = params;

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini", // o el modelo que estás usando en producción
    messages: [
      { role: "system", content: systemMsg },
      { role: "user", content: userMsg },
    ],
    temperature: 0.4,
  });

  const reply = completion.choices[0]?.message?.content ?? "";
  return reply.trim();
}

function bestNameMatch(
  userText: string,
  items: Array<{ id?: string; name: string; url?: string | null }>
) {
  const u = normalizeText(userText);
  if (!u) return null;

  const hits = items.filter((it) => {
    const n = normalizeText(it.name);
    return n.includes(u) || u.includes(n);
  });

  if (hits.length === 1) return hits[0] as any;
  if (hits.length > 1) {
    return hits.sort((a, b) => normalizeText(b.name).length - normalizeText(a.name).length)[0] as any;
  }
  return null;
}

// Detector genérico (no industria)
function isPriceQuestion(text: string) {
  const t = String(text || "").toLowerCase();
  return /\b(precio|precios|cu[aá]nto\s+cuesta|cu[aá]nto\s+vale|costo|cost|price|how\s+much|starts?\s+at|from|desde)\b/i.test(
    t
  );
}

function isFreeOfferQuestion(text: string) {
  const t = String(text || "").toLowerCase();

  const hasFreeWord = /\b(gratis|free)\b/i.test(t);
  const hasTrialWord = /\b(prueba|trial|demo|promocion|promoción)\b/i.test(t);
  const hasClassWord = /\b(clase|class)\b/i.test(t);
  const hasTryVerb = /\b(probar|try|testear|probarla|probarlo)\b/i.test(t);

  if (hasFreeWord && (hasTrialWord || hasClassWord)) return true;
  if (hasTryVerb && hasClassWord) return true;

  return false;
}

function renderFreeOfferList(args: { lang: Lang; items: { name: string }[] }) {
  const { lang, items } = args;

  const intro =
    lang === "en"
      ? "Sure! Here are the free/trial options 😊"
      : "¡Claro! Aquí tienes las opciones gratis/de prueba 😊";

  const ask =
    lang === "en"
      ? "Which one are you interested in? Reply with the number or the name."
      : "¿Cuál te interesa? Responde con el número o el nombre.";

  const listText = items
    .slice(0, 6)
    .map((x, i) => `• ${i + 1}) ${x.name}`)
    .join("\n");

  return `${intro}\n\n${listText}\n\n${ask}`;
}

function norm(s: any) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function isTrialQuery(raw: string): boolean {
  const normalized = String(raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  return (
    normalized.includes("clase de prueba") ||
    normalized.includes("clase prueba") ||
    normalized.includes("prueba gratis") ||
    normalized.includes("clase gratis") ||
    normalized.includes("free class") ||
    normalized.includes("trial") ||
    normalized.includes("demo")
  );
}

// ✅ helper: extraer nombres de planes desde la respuesta del LLM
function extractPlanNamesFromReply(text: string): string[] {
  const lines = String(text || "").split(/\r?\n/);
  const names: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (/^[•\-\*]/.test(line)) {
      let withoutBullet = line.replace(/^[•\-\*]\s*/, "");
      const idx = withoutBullet.indexOf(":");
      if (idx > 0) {
        const name = withoutBullet.slice(0, idx).trim();
        if (name && !names.includes(name)) {
          names.push(name);
        }
      }
    }
  }

  return names;
}

// ✅ Post-procesador: elimina planes ya mencionados en PREVIOUS_PLANS_MENTIONED
function postProcessCatalogReply(params: {
  reply: string;
  questionType: "combination_and_price" | "price_or_plan" | "other_plans";
  prevNames: string[];
}) {
  const { reply, questionType, prevNames } = params;

  if (!prevNames.length) {
    return { finalReply: reply, namesShown: extractPlanNamesFromReply(reply) };
  }

  const prevSet = new Set(prevNames.map((n) => norm(n)));

  const lines = String(reply || "").split(/\r?\n/);
  const filteredLines: string[] = [];

  const bulletRegex = /^[•\-\*]\s*/;

  // Vamos a reconstruir la lista de nombres que realmente se quedan tras el filtro
  const keptNames: string[] = [];

  for (const raw of lines) {
    const line = raw;
    const trimmed = line.trim();

    // Si no es bullet, lo dejamos tal cual (saludos, horarios, etc.)
    if (!trimmed || !bulletRegex.test(trimmed)) {
      filteredLines.push(line);
      continue;
    }

    // Intentar extraer "Nombre del plan" antes de ":"
    const withoutBullet = trimmed.replace(bulletRegex, "");
    const colonIdx = withoutBullet.indexOf(":");
    if (colonIdx <= 0) {
      // bullet raro sin "Nombre: precio" → lo dejamos pasar
      filteredLines.push(line);
      continue;
    }

    const name = withoutBullet.slice(0, colonIdx).trim();
    const nameNorm = norm(name);

    // Si la pregunta es "otros planes", evitamos repetir los ya listados
    if (questionType === "other_plans" && prevSet.has(nameNorm)) {
      // 🔁 Duplicado → lo filtramos
      continue;
    }

    // Lo mantenemos
    filteredLines.push(line);
    keptNames.push(name);
  }

  // Si al filtrar nos quedamos sin bullets nuevos, devolvemos el original
  // para no mandar una respuesta vacía o solo texto suelto.
  if (!keptNames.length) {
    return {
      finalReply: reply,
      namesShown: extractPlanNamesFromReply(reply),
    };
  }

  return {
    finalReply: filteredLines.join("\n"),
    namesShown: keptNames,
  };
}

function extractPlanGroupToken(raw: string): string | null {
  const t = normalizeText(raw);
  if (!t) return null;

  // "plan bronce", "plan gold"
  let m = t.match(/\bplan\s+([a-z0-9]+)\b/);
  if (m?.[1]) return m[1];

  // "paquete bronce"
  m = t.match(/\bpaquete\s+([a-z0-9]+)\b/);
  if (m?.[1]) return m[1];

  // "package bronze" (por si preguntan en inglés)
  m = t.match(/\bpackage\s+([a-z0-9]+)\b/);
  if (m?.[1]) return m[1];

  return null;
}

function humanizeListReply(reply: string, idioma: "es" | "en") {
  const closingEs = [
    "¿Cuál te gustaría probar?",
    "¿Quieres que te recomiende la mejor según tu objetivo? 😊",
    "Si quieres te guío según lo que estés buscando 😊",
    "¿Cuál opción te interesa más?"
  ];

  const closingEn = [
    "Which one looks best for you?",
    "Do you want me to recommend the best option for you? 😊",
    "If you want, I can guide you based on your goals 😊",
    "Which option are you leaning toward?"
  ];

  const pick = idioma === "es"
    ? closingEs[Math.floor(Math.random() * closingEs.length)]
    : closingEn[Math.floor(Math.random() * closingEn.length)];

  // Si ya contiene pregunta final, no duplicamos
  if (/interesa|interested|recommend/i.test(reply)) return reply;

  return `${reply}\n\n${pick}`;
}

function stripLinkSentences(reply: string): string {
  const lines = String(reply || "").split(/\r?\n/);

  const filtered = lines.filter((line) => {
    const l = line.toLowerCase().trim();
    if (!l) return true;

    // Si la línea habla de links / enlaces / comprar en enlaces, la quitamos
    if (
      l.includes("enlace") ||
      l.includes("enlaces") ||
      l.includes("link") ||
      l.includes("links") ||
      l.includes("comprar en los enlaces") ||
      l.includes("comprar en los links")
    ) {
      return false;
    }

    return true;
  });

  // Normaliza saltos de línea
  return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export async function runFastpath(args: RunFastpathArgs): Promise<FastpathResult> {
  const {
    pool,
    tenantId,
    canal,
    idiomaDestino,
    userInput,
    inBooking,
    convoCtx,
    infoClave,
    detectedIntent,
    maxDisambiguationOptions = 5,
    lastServiceTtlMs = 60 * 60 * 1000,
  } = args;

  const q = userInput.toLowerCase().trim();

  if (inBooking) return { handled: false };

  const intentOut = (detectedIntent || "").trim() || null;

  // ===============================
  // ✅ Dismiss Fastpath
  // ===============================
  {
    const hasFastpathContext =
      (Array.isArray(convoCtx?.last_plan_list) && convoCtx.last_plan_list.length > 0) ||
      (Array.isArray(convoCtx?.last_package_list) && convoCtx.last_package_list.length > 0) ||
      !!convoCtx?.last_service_id ||
      !!convoCtx?.pending_price_lookup ||
      !!convoCtx?.pending_link_lookup;

    const explicitNoThanks =
      /\b(no gracias|no, gracias|no por ahora|no quiero|no necesito|estoy bien|todo bien)\b/i.test(q) ||
      /\b(no thanks|no, thanks|i'm good|im good|all good|not now)\b/i.test(q);

    const plainThanks = /\b(gracias|thanks)\b/i.test(q);

    const isFastpathDismiss = explicitNoThanks || (plainThanks && hasFastpathContext);

    if (isFastpathDismiss) {
      const now = Date.now();

      const ctxPatch: Partial<FastpathCtx> = {
        last_plan_list: undefined,
        last_plan_list_at: undefined,
        last_package_list: undefined,
        last_package_list_at: undefined,
        last_list_kind: undefined,
        last_list_kind_at: undefined,

        last_service_id: null,
        last_service_name: null,
        last_service_at: null,

        pending_price_lookup: undefined,
        pending_price_at: undefined,

        pending_link_lookup: undefined,
        pending_link_at: undefined,
        pending_link_options: undefined,

        last_price_option_label: undefined,
        last_price_option_at: undefined,

        last_selected_kind: null,
        last_selected_id: null,
        last_selected_name: null,
        last_selected_at: null,

        // limpia también histórico de catálogo
        last_catalog_plans: undefined,
        last_catalog_at: undefined,

        last_bot_action: "fastpath_dismiss",
        last_bot_action_at: now,
      };

      const reply =
        idiomaDestino === "en"
          ? "Perfect, if you need anything else just let me know 😊"
          : "Perfecto 😊 si necesitas algo más, aquí estoy para ayudarte.";

      return {
        handled: true,
        reply,
        source: "fastpath_dismiss",
        intent: intentOut || "fastpath_dismiss",
        ctxPatch,
      };
    }
  }

  // ===============================
  // ✅ INFO GENERAL OVERVIEW
  // ===============================
  if (intentOut === "info_general") {
    const ctxPatch: any = {
      last_list_kind: null,
      last_list_kind_at: null,
      last_plan_list: null,
      last_plan_list_at: null,
      last_package_list: null,
      last_package_list_at: null,
    };

    const reply = await renderInfoGeneralOverview({
      pool,
      tenantId,
      lang: idiomaDestino,
    });

    return {
      handled: true,
      source: "service_list_db",
      intent: intentOut,
      reply,
      ctxPatch,
    };
  }

  // ===============================
  // ✅ PICK FROM LAST LIST
  // ===============================
  {
    const ttlMs = 5 * 60 * 1000;

    const planList = Array.isArray(convoCtx?.last_plan_list) ? convoCtx.last_plan_list : [];
    const planAtRaw = (convoCtx as any)?.last_plan_list_at;
    const planAt = Number(planAtRaw);
    const planAtOk = Number.isFinite(planAt) && planAt > 0;
    const planFresh = planList.length > 0 && (!planAtOk || Date.now() - planAt <= ttlMs);

    const pkgList = Array.isArray(convoCtx?.last_package_list) ? convoCtx.last_package_list : [];
    const pkgAtRaw = (convoCtx as any)?.last_package_list_at;
    const pkgAt = Number(pkgAtRaw);
    const pkgAtOk = Number.isFinite(pkgAt) && pkgAt > 0;
    const pkgFresh = pkgList.length > 0 && (!pkgAtOk || Date.now() - pkgAt <= ttlMs);

    const kind = (convoCtx?.last_list_kind as any) || null;
    const kindAtRaw = (convoCtx as any)?.last_list_kind_at;
    const kindAt = Number(kindAtRaw);
    const kindAtOk = Number.isFinite(kindAt) && kindAt > 0;
    const kindFresh = Boolean(kind) && (!kindAtOk || Date.now() - kindAt <= ttlMs);

    const healPatch: Partial<FastpathCtx> = {};

    if (planList.length > 0 && !planAtOk) healPatch.last_plan_list_at = Date.now();
    if (pkgList.length > 0 && !pkgAtOk) healPatch.last_package_list_at = Date.now();
    if (kind && !kindAtOk) healPatch.last_list_kind_at = Date.now();

    if (planFresh || pkgFresh) {
      if (isTrialQuery(userInput)) {
        console.log("🧪 PICK SKIP — trial/demo query, dejar a otras reglas manejarlo");
      } else {
        const idx = (() => {
          const t = String(userInput || "").trim();
          const m = t.match(/^([1-9])$/);
          return m ? Number(m[1]) : null;
        })();

        const msgNorm = normalizeText(userInput);

        const mentionsPlanFromList =
          planFresh &&
          planList.some((p: any) => {
            const name = String(p?.name ?? p?.label ?? "").trim();
            if (!name) return false;
            const nameNorm = normalizeText(name);
            return !!nameNorm && msgNorm.includes(nameNorm);
          });

        const mentionsPackageFromList =
          pkgFresh &&
          pkgList.some((p: any) => {
            const name = String(p?.name ?? p?.label ?? "").trim();
            if (!name) return false;
            const nameNorm = normalizeText(name);
            return !!nameNorm && msgNorm.includes(nameNorm);
          });

        if (!mentionsPlanFromList && !mentionsPackageFromList && idx == null) {
          console.log("🧪 PICK SKIP — no numeric choice or plan/package mention in msg");
        } else {
          const tryPick = (
            list: Array<{ id: string; name: string; url: string | null }>,
            kind: "plan" | "package"
          ) => {
            let picked: { id: string; name: string; url: string | null } | null = null;

            if (idx != null) {
              const i = idx - 1;
              if (i >= 0 && i < list.length) picked = list[i];
            }
            if (!picked) picked = bestNameMatch(userInput, list as any) as any;
            return picked ? { ...picked, kind } : null;
          };

          let picked: { id: string; name: string; url: string | null; kind: "plan" | "package" } | null =
            null;

          if (kindFresh && kind === "package") {
            if (pkgFresh) picked = tryPick(pkgList, "package");
            if (!picked && planFresh) picked = tryPick(planList, "plan");
          } else {
            if (planFresh) picked = tryPick(planList, "plan");
            if (!picked && pkgFresh) picked = tryPick(pkgList, "package");
          }

          if (picked) {
            const rawPickedId = String(picked.id || "");
            const parts = rawPickedId.split("::");
            const pickedServiceId = parts[0] || rawPickedId;
            const pickedOptionLabel = parts.length > 1 ? parts.slice(1).join("::") : null;

            const basePatch: Partial<FastpathCtx> = {
              last_plan_list: undefined,
              last_plan_list_at: undefined,
              last_package_list: undefined,
              last_package_list_at: undefined,
              last_list_kind: undefined,
              last_list_kind_at: undefined,

              last_selected_kind: picked.kind,
              last_selected_id: picked.id,
              last_selected_name: picked.name,
              last_selected_at: Date.now(),

              last_service_id: pickedServiceId,
              last_service_name: picked.name,
              last_service_at: Date.now(),

              last_price_option_label: pickedOptionLabel,
              last_price_option_at: Date.now(),
            };

            let finalUrl: string | null = picked.url ? String(picked.url).trim() : null;

            if (!finalUrl) {
              const linkPick = await resolveBestLinkForService({
                pool,
                tenantId,
                serviceId: pickedServiceId,
                userText: userInput,
              });

              if (linkPick.ok) {
                finalUrl = linkPick.url;
              } else if (linkPick.reason === "ambiguous") {
                const labels = linkPick.options
                  .slice(0, 3)
                  .map((o) => o.label)
                  .filter(Boolean);

                const q =
                  idiomaDestino === "en"
                    ? `Just to make sure 😊 are you asking about ${labels.join(" or ")}?`
                    : `Solo para asegurarme 😊 ¿hablas de ${labels.join(" o ")}?`;

                return {
                  handled: true,
                  reply: q,
                  source: "service_list_db",
                  intent: intentOut || "seleccion",
                  ctxPatch: {
                    ...healPatch,
                    ...basePatch,
                    pending_link_lookup: true,
                    pending_link_at: Date.now(),
                    pending_link_options: linkPick.options,
                    last_bot_action: "asked_link_option",
                    last_bot_action_at: Date.now(),
                  } as any,
                };
              }
            }

            const d = await getServiceDetailsText(tenantId, pickedServiceId, userInput).catch(
              () => null
            );

            const baseName = String(convoCtx?.last_service_name || "") || String(picked.name || "");
            const title = d?.titleSuffix ? `${baseName} — ${d.titleSuffix}` : baseName;

            const infoText = d?.text ? String(d.text).trim() : "";

            if (!finalUrl) {
              const linkPick2 = await resolveBestLinkForService({
                pool,
                tenantId,
                serviceId: pickedServiceId,
                userText: userInput,
              }).catch(() => null);

              if (linkPick2?.ok) finalUrl = linkPick2.url;
            }

            const reply =
              idiomaDestino === "en"
                ? `${title}${infoText ? `\n\n${infoText}` : ""}${
                    finalUrl ? `\n\nHere’s the link:\n${finalUrl}` : ""
                  }`
                : `${title}${infoText ? `\n\n${infoText}` : ""}${
                    finalUrl ? `\n\nAquí está el link:\n${finalUrl}` : ""
                  }`;

            return {
              handled: true,
              reply,
              source: "service_list_db",
              intent: intentOut || "seleccion",
              ctxPatch: {
                ...basePatch,
                pending_link_lookup: undefined,
                pending_link_at: undefined,
                pending_link_options: undefined,
                last_bot_action: "sent_details",
                last_bot_action_at: Date.now(),
              } as any,
            };
          }
        }
      }
    }
  }

  // ===============================
  // ✅ ANTI-LOOP PENDING LINK
  // ===============================
  {
    const ttlMs = 5 * 60 * 1000;

    const pending = Boolean(convoCtx?.pending_link_lookup);
    const pendingAt = Number(convoCtx?.pending_link_at || 0);
    const pendingOptions = Array.isArray(convoCtx?.pending_link_options)
      ? convoCtx.pending_link_options
      : [];

    const pendingFresh =
      pending && pendingAt > 0 && Date.now() - pendingAt <= ttlMs && pendingOptions.length > 0;

    if (pending && !pendingFresh) {
      return {
        handled: false,
        ctxPatch: {
          pending_link_lookup: undefined,
          pending_link_at: undefined,
          pending_link_options: undefined,
        } as any,
      };
    }

    if (pendingFresh) {
      const normLocal = (s: string) =>
        String(s || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .trim();

      const tNorm = normLocal(userInput);

      const looksLikeCancel =
        /\b(no|no\s+gracias|gracias|thanks|cancelar|olvidalo|olvidalo|stop)\b/.test(tNorm);

      const idx = (() => {
        const m = tNorm.match(/^([1-9])$/);
        if (!m) return null;
        const n = Number(m[1]);
        return Number.isFinite(n) ? n : null;
      })();

      const looksLikeOptionByIndex =
        idx != null && idx >= 1 && idx <= Math.min(9, pendingOptions.length);

      const labelWordHit = pendingOptions.some((o: any) => {
        const labelNorm = normLocal(o?.label || "");
        if (!labelNorm) return false;
        const words = labelNorm.split(/\s+/).filter((w) => w.length >= 3);
        return words.some((w) => tNorm.includes(w));
      });

      const looksLikeOptionAnswer = looksLikeOptionByIndex || labelWordHit;

      if (looksLikeCancel || !looksLikeOptionAnswer) {
        return {
          handled: false,
          ctxPatch: {
            pending_link_lookup: undefined,
            pending_link_at: undefined,
            pending_link_options: undefined,
          } as any,
        };
      }
    }
  }

  // ===============================
  // ✅ FREE OFFER
  // ===============================
  {
    const wantsFreeOffer = isFreeOfferQuestion(userInput);

    if (wantsFreeOffer) {
      const { rows } = await pool.query(
        `
        SELECT s.id, s.name, s.service_url
        FROM services s
        WHERE s.tenant_id = $1
          AND s.active = true
          AND COALESCE(s.price_base, 0) <= 0
          AND s.service_url IS NOT NULL
          AND length(trim(s.service_url)) > 0
        ORDER BY s.updated_at DESC NULLS LAST, s.created_at DESC
        LIMIT 10
        `,
        [tenantId]
      );

      const items = (rows || [])
        .map((r: any) => ({
          id: String(r.id),
          name: String(r.name || "").trim(),
          url: r.service_url ? String(r.service_url).trim() : null,
        }))
        .filter((x) => x.name && x.url);

      if (!items.length) {
        const msg =
          idiomaDestino === "en"
            ? "Yes — we can help with a free/trial option 😊 What exactly are you looking for?"
            : "Sí — podemos ayudarte con una opción gratis/de prueba 😊 ¿Qué estás buscando exactamente?";
        return { handled: true, reply: msg, source: "service_list_db", intent: "free_offer" };
      }

      if (items.length === 1) {
        const one = items[0];
        return {
          handled: true,
          reply: `${one.name}\n${one.url}`,
          source: "service_list_db",
          intent: "free_offer",
          ctxPatch: {
            last_service_id: one.id,
            last_service_name: one.name,
            last_service_at: Date.now(),
          },
        };
      }

      const reply = renderFreeOfferList({
        lang: idiomaDestino,
        items: items.map((x) => ({ name: x.name })),
      });

      return {
        handled: true,
        reply,
        source: "service_list_db",
        intent: "free_offer",
        ctxPatch: {
          last_plan_list: items.map((x) => ({ id: x.id, name: x.name, url: x.url })),
          last_plan_list_at: Date.now(),
          last_list_kind: "plan",
          last_list_kind_at: Date.now(),
        },
      };
    }
  }

  // ===============================
  // ✅ INTEREST -> LINK
  // ===============================
  {
    const t = String(userInput || "").trim();
    const tNorm = normalizeText(userInput);

    const wantsLink =
      /\b(link|enlace|url|web|website|sitio|pagina|página|comprar|buy|pagar|checkout)\b/i.test(
        tNorm
      );

    const pending = Boolean(convoCtx?.pending_link_lookup);

    const lastAct = String(convoCtx?.last_bot_action || "");
    const lastActAt = Number(convoCtx?.last_bot_action_at || 0);
    const justSentDetails =
      lastAct === "sent_details" && lastActAt > 0 && Date.now() - lastActAt < 2 * 60 * 1000;

    if (justSentDetails && !pending) {
      return { handled: false };
    }

    if ((wantsLink || pending) && convoCtx?.last_service_id) {
      const pick = await resolveBestLinkForService({
        pool,
        tenantId,
        serviceId: String(convoCtx.last_service_id),
        userText: userInput,
      });

      if (pick.ok) {
        const serviceId = String(convoCtx.last_service_id);
        const baseName = String(convoCtx?.last_service_name || "").trim();

        const d = await getServiceDetailsText(tenantId, serviceId, userInput).catch(() => null);

        const title = d?.titleSuffix
          ? `${baseName || ""}${baseName ? " — " : ""}${String(d.titleSuffix).trim()}`
          : baseName;

        const infoText = d?.text ? String(d.text).trim() : "";

        const outro =
          idiomaDestino === "en"
            ? "If you need anything else, just let me know 😊"
            : "Si necesitas algo más, déjame saber 😊";

        let reply =
          idiomaDestino === "en"
            ? `${title ? `${title}\n\n` : ""}${infoText ? `${infoText}\n\n` : ""}Here it is 😊\n${
                pick.url
              }\n\n${outro}`
            : `${title ? `${title}\n\n` : ""}${infoText ? `${infoText}\n\n` : ""}Aquí lo tienes 😊\n${
                pick.url
              }\n\n${outro}`;

        const variantId =
          (convoCtx as any)?.last_variant_id ? String((convoCtx as any).last_variant_id) : null;

        try {
          const { serviceUrl, variantUrl } = await getServiceAndVariantUrl(
            pool,
            tenantId,
            serviceId,
            variantId
          );

          const finalUrl = variantUrl || serviceUrl;

          if (finalUrl) {
            const linkLine =
              idiomaDestino === "en"
                ? `\n\n👉 You can see all the details or purchase here: ${finalUrl}`
                : `\n\n👉 Puedes ver todos los detalles o comprarlo aquí: ${finalUrl}`;

            reply = `${reply}${linkLine}`;
          }
        } catch (e: any) {
          console.warn("⚠️ runFastpath: no se pudo adjuntar URL de servicio:", e?.message);
        }

        return {
          handled: true,
          reply,
          source: "service_list_db",
          intent: intentOut || "link",
          ctxPatch: {
            last_bot_action: "sent_link_with_details",
            last_bot_action_at: Date.now(),
            pending_link_lookup: undefined,
            pending_link_at: undefined,
            pending_link_options: undefined,
          } as any,
        };
      }

      if (!pick.ok && pick.reason === "ambiguous") {
        const labels = pick.options
          .slice(0, 3)
          .map((o) => o.label)
          .filter(Boolean);

        const q =
          idiomaDestino === "en"
            ? `Sure 😊 Which option do you want— ${labels.join(" or ")}?`
            : `Perfecto 😊 ¿Cuál opción quieres— ${labels.join(" o ")}?`;

        return {
          handled: true,
          reply: q,
          source: "service_list_db",
          intent: intentOut || "link",
          ctxPatch: {
            pending_link_lookup: true,
            pending_link_at: Date.now(),
            pending_link_options: pick.options,
          } as any,
        };
      }
    }
  }

  // =========================================================
  // ✅ FOLLOW-UP ROUTER
  // =========================================================
  {
    const t = String(userInput || "").trim();
    const tLower = t.toLowerCase();

    const isShort =
      t.length > 0 &&
      t.length <= 22 &&
      !t.includes("?") &&
      !/\b(hola|hi|hello|gracias|thanks)\b/i.test(tLower);

    const now = Date.now();

    const ttlMs = 10 * 60 * 1000;

    const fresh = (at: any) => {
      const n = Number(at || 0);
      return Number.isFinite(n) && n > 0 && now - n <= ttlMs;
    };

    const pendingPrice =
      Boolean((convoCtx as any)?.pending_price_lookup) &&
      fresh((convoCtx as any)?.pending_price_at);
    const pendingLink =
      Boolean((convoCtx as any)?.pending_link_lookup) && fresh((convoCtx as any)?.pending_link_at);

    const lastServiceId = String((convoCtx as any)?.last_service_id || "").trim();
    const lastServiceFresh = lastServiceId && fresh((convoCtx as any)?.last_service_at);

    const planList = Array.isArray((convoCtx as any)?.last_plan_list)
      ? (convoCtx as any).last_plan_list
      : [];
    const pkgList = Array.isArray((convoCtx as any)?.last_package_list)
      ? (convoCtx as any).last_package_list
      : [];
    const listFresh =
      (planList.length && fresh((convoCtx as any)?.last_plan_list_at)) ||
      (pkgList.length && fresh((convoCtx as any)?.last_package_list_at));

    if (isShort && pendingLink && Array.isArray((convoCtx as any)?.pending_link_options)) {
      const opts = (convoCtx as any).pending_link_options;
      const pick = bestNameMatch(t, opts.map((o: any) => ({ name: o.label })) as any);

      if (pick?.name) {
        return {
          handled: false,
          ctxPatch: {
            pending_link_lookup: null,
            pending_link_at: null,
            pending_link_options: null,
            last_bot_action: "followup_link_pick",
            last_bot_action_at: now,
          } as any,
        };
      }
    }

    if (isShort && listFresh) {
      // deja que PICK FROM LAST LIST lo maneje
    } else {
      if (isShort && pendingPrice) {
        const hit = await resolveServiceIdFromText(pool, tenantId, t);
        if (hit?.id) {
          return {
            handled: false,
            ctxPatch: {
              last_service_id: hit.id,
              last_service_name: hit.name,
              last_service_at: now,
              pending_price_lookup: null,
              pending_price_at: null,
              last_bot_action: "followup_set_service_for_price",
              last_bot_action_at: now,
            } as any,
          };
        }
      }

      if (isShort && lastServiceFresh) {
        return {
          handled: false,
          ctxPatch: {
            last_price_option_label: t,
            last_price_option_at: now,
            last_bot_action: "followup_option_label",
            last_bot_action_at: now,
          } as any,
        };
      }
    }
  }

  // ===============================
  // ✅ VARIANTES: SEGUNDO TURNO
  // El usuario ya vio las opciones y ahora elige una (1, "autopay", etc.)
  // ===============================
  if (convoCtx.expectingVariant && convoCtx.selectedServiceId) {
    const serviceId = String(convoCtx.selectedServiceId);

    // Traemos variantes del servicio
    const { rows: variants } = await pool.query<any>(
      `
      SELECT
        id,
        variant_name,
        description,
        variant_url,
        price,
        currency
      FROM service_variants
      WHERE service_id = $1
        AND active = true
      ORDER BY created_at ASC, id ASC
      `,
      [serviceId]
    );

    if (!variants.length) {
      // No hay variantes, limpiamos bandera y dejamos que el resto del fastpath maneje
      return {
        handled: false,
        ctxPatch: {
          expectingVariant: false,
          selectedServiceId: null,
        } as Partial<FastpathCtx>,
      };
    }

    const msgNorm = normalizeText(userInput);

    let chosen: any = null;

    // Opción numérica: "1", "2", etc.
    const mNum = msgNorm.match(/^([1-9])$/);
    if (mNum) {
      const idx = Number(mNum[1]) - 1;
      if (idx >= 0 && idx < variants.length) {
        chosen = variants[idx];
      }
    }

    // Opción por nombre: "autopay", "por mes", "bronce cycling", etc.
    if (!chosen) {
      const msgTokens = msgNorm
        .split(/\s+/)
        .filter((t) => t.length > 1); // quitamos palabras de 1 carácter

      chosen = variants.find((v: any) => {
        const nameNorm = normalizeText(v.variant_name || "");
        if (!nameNorm) return false;

        // Coincidencia por tokens: basta con que al menos un token de la frase
        // esté contenido en el nombre de la variante.
        return msgTokens.some((t) => nameNorm.includes(t));
      });
    }

    // --------------------------------------
    // 🌎 DETECCIÓN INTELIGENTE DE VARIANTES
    // (MULTITENANT – sin hardcode por negocio)
    // --------------------------------------
    if (!chosen) {
      const msg = msgNorm; // ya normalizado

      // Palabras universales que significan "mes / mensual"
      const monthlyTokens = [
        "por mes",
        "mensual",
        "mensualmente",
        "mes a mes",
        "per month",
        "monthly"
      ];

      // Palabras universales que significan "autopay"
      const autopayTokens = [
        "autopay",
        "auto pay",
        "pago automatico",
        "pago automático",
        "automatic payment",
        "auto debit",
        "autodebit",
        "auto-debit"
      ];

      const matchTokens = (tokens: string[], variantName: string) => {
        const vn = normalizeText(variantName);
        return tokens.some((t) => msg.includes(normalizeText(t)) || vn.includes(normalizeText(t)));
      };

      // Buscar variante mensual (Por Mes)
      let monthlyVariant = variants.find((v: any) =>
        matchTokens(monthlyTokens, v.variant_name || "")
      );

      // Buscar variante autopay
      let autopayVariant = variants.find((v: any) =>
        matchTokens(autopayTokens, v.variant_name || "")
      );

      if (monthlyVariant && matchTokens(monthlyTokens, msg)) {
        chosen = monthlyVariant;
      }

      if (!chosen && autopayVariant && matchTokens(autopayTokens, msg)) {
        chosen = autopayVariant;
      }
    }

    if (!chosen) {
      const retryMsg =
        idiomaDestino === "en"
          ? "No terminé de entender cuál opción te interesa 🤔. Dime el número o el nombre de la opción."
          : "No terminé de entender cuál opción te interesa 🤔. Dime el número o el nombre de la opción.";
      return {
        handled: true,
        reply: retryMsg,
        source: "service_list_db",
        intent: intentOut || "info_servicio",
      };
    }

    // Sacamos datos del servicio base
    const {
      rows: [service],
    } = await pool.query<any>(
      `
      SELECT
        name,
        description,
        service_url
      FROM services
      WHERE id = $1
      `,
      [serviceId]
    );

    const descSource = (
      chosen.description ||
      service?.description ||
      ""
    ).trim();

    const link: string | null =
      chosen.variant_url || service?.service_url || null;

    const bullets: string =
      descSource
        ? descSource
            .split(/\r?\n/)
            .map((l: string) => l.trim())
            .filter((l: string) => l.length > 0)
            .map((l: string) => `• ${l}`)
            .join("\n")
        : "";

    const baseName = String(service?.name || "").trim();
    const variantName = String(chosen.variant_name || "").trim();

    const title =
      baseName && variantName
        ? `${baseName} — ${variantName}`
        : baseName || variantName || "";

    let reply =
      idiomaDestino === "en"
        ? `Perfect 😊\n\n${title ? `*${title}*` : ""}${
            bullets ? ` includes:\n\n${bullets}` : ""
          }`
        : `Perfecto 😊\n\n${title ? `*${title}*` : ""}${
            bullets ? ` incluye:\n\n${bullets}` : ""
          }`;

    if (link) {
      reply +=
        idiomaDestino === "en"
          ? `\n\nHere you can see more details:\n${link}`
          : `\n\nAquí puedes ver más detalles:\n${link}`;
    }

    console.log("[FASTPATH-INCLUDES] variante elegida", {
      userInput,
      serviceId,
      baseName,
      variantName,
      link,
    });
    return {
      handled: true,
      reply,
      source: "service_list_db",
      intent: intentOut || "info_servicio",
      ctxPatch: {
        expectingVariant: false,
        selectedServiceId: serviceId,
        last_service_id: serviceId,
        last_service_name: baseName || title || null,
        last_service_at: Date.now(),
      } as Partial<FastpathCtx>,
    };
  }

  // ===============================
  // ✅ VARIANTES: PRIMER TURNO
  // El usuario pregunta "qué incluye X" y detectamos el servicio
  // (GENÉRICO: sirve para cualquier nombre, sin hardcodear bronce/basic/etc.)
  // ===============================
  // Texto normalizado para detectar intención de detalle
  const normMsg = normalizeText(userInput);

  // Pregunta explícita de detalle: "qué incluye X", "que trae X", etc.
  // Pregunta explícita de detalle: "qué incluye X", "que trae X", "dame más detalle", "more details", etc.
  const looksLikeExplicitDetail =
    /\b(que incluye|qué incluye|que trae|qué trae|incluye|incluyen|mas detalle|más detalle|dame mas detalle|dame más detalle|detalle|detalles|what\s+is\s+included|what\s+does.*include|more detail|more details|give me more detail|tell me more about)\b/i.test(
      normMsg
    );

  // Follow-up elíptico tipo "y el gold?", "y el bronce?"
  // Lo consideramos detalle SI después de "y el/la" viene algo.
  const looksLikeEllipticDetail =
    /^y\s+(el|la)\s+.+\??$/i.test(normMsg) ||        // español
    /^and\s+(the\s+)?[^?]+(\?)?$/i.test(normMsg);    // inglés

  const looksLikeServiceDetail = looksLikeExplicitDetail || looksLikeEllipticDetail;

  if (looksLikeServiceDetail) {
    // Detectar servicio por texto ("plan bronce", "basic bath", "deluxe groom", "facial", etc.)
    // Detectar servicio por texto ("plan bronce", "basic bath", etc.)
    let hit: any = await resolveServiceIdFromText(pool, tenantId, userInput, {
      mode: "loose",
    });

    // 🛠 FIX: Si el texto coincide con una variante exacta,
    // NO tratamos esa variante como un servicio independiente.
    if (hit && hit.isVariant) {
      const serviceOfVariant = hit.service_id;

      // Reescribimos hit para que el motor trate esto como SERVICIO
      hit = {
        id: serviceOfVariant,
        name: hit.parent_service_name,
      };
    }

    // 🔥 PATCH NUEVO: si es detalle pero no se encontró servicio por texto,
    // usar SERVICE en contexto (último plan mostrado o seleccionado)
    if (!hit) {
      // 1) Si venimos de una lista de un solo plan (ej: después de "y el gold?")
      if (convoCtx?.last_plan_list?.length === 1) {
        hit = {
          id: convoCtx.last_plan_list[0].id,
          name: convoCtx.last_plan_list[0].name,
        };
      }
      // 2) Si hay un servicio seleccionado previamente
      else if (convoCtx?.selectedServiceId) {
        hit = {
          id: convoCtx.selectedServiceId,
          name: convoCtx.last_service_name || "",
        };
      }
      // 3) Si hay un servicio recordado recientemente
      else if (convoCtx?.last_service_id) {
        hit = {
          id: convoCtx.last_service_id,
          name: convoCtx.last_service_name || "",
        };
      }
    }

    // Si después de intentar contexto TAMPOCO hay servicio, dejar catálogo/LLM
    if (!hit) {
      // No encontramos servicio claro → motor catálogo
    } else {
      const serviceId = hit.id;

      // Traer variantes de ese servicio
      const { rows: variants } = await pool.query<any>(
        `
        SELECT
          id,
          variant_name,
          description,
          variant_url,
          price,
          currency
        FROM service_variants
        WHERE service_id = $1
          AND active = true
        ORDER BY created_at ASC, id ASC
        `,
        [serviceId]
      );

      // Traer info básica del servicio
      const {
        rows: [service],
      } = await pool.query<any>(
        `
        SELECT
          name,
          description,
          service_url
        FROM services
        WHERE id = $1
        `,
        [serviceId]
      );

      const serviceName = String(service?.name || hit.name || "").trim();

      // ⭐ Caso A: tiene variantes → listamos opciones y preguntamos cuál le interesa
      if (variants.length > 0) {
        console.log("[FASTPATH-INCLUDES] variantes primer turno", {
          userInput,
          serviceId,
          serviceName,
          variants: variants.map((v: any) => v.variant_name),
        });

        // Nombre que vamos a mostrar del servicio (traducido si aplica)
        let displayServiceName = serviceName;

        // Si el cliente está en inglés, intentamos traducir el nombre del servicio
        if (idiomaDestino === "en" && serviceName) {
          try {
            // 👇 Ajusta la firma si tu helper `traducirMensaje` recibe otros parámetros
            displayServiceName = await traducirMensaje(serviceName, "en");
          } catch (e) {
            console.warn("[FASTPATH-INCLUDES] error traduciendo nombre de servicio:", e);
          }
        }

        // Construimos las líneas de variantes (traduciendo el nombre si el cliente está en EN)
        const lines = await Promise.all(
          variants.map(async (v: any, idx: number) => {
            const rawPrice = v.price;

            // Postgres suele devolver NUMERIC como string → lo convertimos
            const numPrice =
              rawPrice === null || rawPrice === undefined || rawPrice === ""
                ? NaN
                : Number(rawPrice);

            const currency = (v.currency as string | null) || "USD";
            const hasPrice = Number.isFinite(numPrice);
            const priceText = hasPrice ? `${numPrice} ${currency}` : "";

            let displayVariantName = String(v.variant_name || "").trim();

            if (idiomaDestino === "en" && displayVariantName) {
              try {
                // 👇 Igual: adapta la firma si tu helper es distinto
                displayVariantName = await traducirMensaje(displayVariantName, "en");
              } catch (e) {
                console.warn(
                  "[FASTPATH-INCLUDES] error traduciendo nombre de variante:",
                  e
                );
              }
            }

            return priceText
              ? `• ${idx + 1}) ${displayVariantName}: ${priceText}`
              : `• ${idx + 1}) ${displayVariantName}`;
          })
        );

        const headerEs = `El ${serviceName} tiene estas opciones:`;
        const headerEn = `The ${displayServiceName} has these options:`;

        const askEs =
          "¿Cuál opción te interesa? Puedes responder con el número o el nombre.";
        const askEn =
          "Which option are you interested in? You can answer with the number or the name.";

        const reply =
          idiomaDestino === "en"
            ? `${headerEn}\n\n${lines.join("\n")}\n\n${askEn}`
            : `${headerEs}\n\n${lines.join("\n")}\n\n${askEs}`;

        return {
          handled: true,
          reply,
          source: "service_list_db",
          intent: intentOut || "info_servicio",
          ctxPatch: {
            selectedServiceId: serviceId,
            expectingVariant: true,
          } as Partial<FastpathCtx>,
        };
      }

      // ⭐ Caso B: NO tiene variantes → respondemos directo con descripción + link
      const descSource = (service?.description || "").trim();
      const link: string | null = service?.service_url || null;

      let displayServiceName = serviceName;      // puede venir vacío — NO inventamos nada
      let displayBullets = descSource;

      // --------------------------------------
      // 🌎 TRADUCCIÓN (solo si el cliente habla EN)
      // --------------------------------------
      if (idiomaDestino === "en") {
        try {
          if (displayServiceName) {
            displayServiceName = await traducirMensaje(displayServiceName, "en");
          }
        } catch (e) {
          console.warn("[FASTPATH] error traduciendo nombre (sin variantes):", e);
        }

        try {
          if (displayBullets) {
            const bulletList: string[] = displayBullets
              .split(/\r?\n/)
              .map((l: string) => l.trim())
              .filter((l: string) => l.length > 0);

            const translated: string[] = [];
            for (const b of bulletList) {
              translated.push(await traducirMensaje(b, "en"));
            }

            displayBullets = translated.join("\n");
          }
        } catch (e) {
          console.warn("[FASTPATH] error traduciendo bullets (sin variantes):", e);
        }
      }

      // --------------------------------------
      // Generar bullets visuales
      // --------------------------------------
      const bullets =
        displayBullets
          ? displayBullets
              .split(/\r?\n/)
              .map((l: string) => l.trim())
              .filter((l: string) => l.length > 0)
              .map((l: string) => `• ${l}`)
              .join("\n")
          : "";

      // --------------------------------------
      // Respuesta final SIN hardcode de tipo
      // --------------------------------------

      // ❗ No mostramos "Este plan" ni "This plan"
      // Si hay nombre → mostramos nombre.
      // Si NO hay nombre → solo mostramos bullets (sin inventar nada).
      let reply: string;

      if (idiomaDestino === "en") {
        reply = displayServiceName
          ? `${displayServiceName}${bullets ? ` includes:\n\n${bullets}` : ""}`
          : bullets
          ? `Includes:\n\n${bullets}`
          : "";
      } else {
        reply = displayServiceName
          ? `${displayServiceName}${bullets ? ` incluye:\n\n${bullets}` : ""}`
          : bullets
          ? `Incluye:\n\n${bullets}`
          : "";
      }

      if (link) {
        reply +=
          idiomaDestino === "en"
            ? `\n\nHere you can see more details:\n${link}`
            : `\n\nAquí puedes ver más detalles:\n${link}`;
      }

      return {
        handled: true,
        reply,
        source: "service_list_db",
        intent: intentOut || "info_servicio",
        ctxPatch: {
          selectedServiceId: serviceId,
          expectingVariant: false,
          last_service_id: serviceId,
          last_service_name: serviceName,
          last_service_at: Date.now(),
        } as Partial<FastpathCtx>,
      };
    }
  }

  // ===============================
  // 🧠 MOTOR ÚNICO DE CATÁLOGO
  // ===============================
    {
    // 👇 1) Intento de "plan combinado"
    const isCombinationIntent =
      q.includes("combinar") ||
      q.includes("mezclar") ||
      q.includes("usar ambas") ||
      q.includes("usar las dos") ||
      q.includes("combine classes") ||
      q.includes("use both") ||
      q.includes("combinada") ||
      q.includes("combinado") ||
      q.includes("ambas clases") ||
      q.includes("ambos tipos") ||
      q.includes("all inclusive") ||
      q.includes("todo incluido");

    // 👇 2) Preguntas típicas de precios/planes
    const isCatalogQuestionBasic =
      q.includes("precio") ||
      q.includes("precios") ||
      q.includes("cuanto cuesta") ||
      q.includes("cuánto cuesta") ||
      q.includes("costo") ||
      q.includes("cuesta") ||
      q.includes("plan") ||
      q.includes("planes") ||
      q.includes("membresia") ||
      q.includes("membresía") ||
      q.includes("clases") ||
      q.includes("servicio") ||
      q.includes("servicios") ||
      q.includes("que incluye") ||
      q.includes("qué incluye") ||
      q.includes("incluye") ||
      q.includes("unlimited") ||
      q.includes("ilimitado") ||
      q.includes("pack") ||
      q.includes("paquete") ||
      q.includes("autopay") ||
      q.includes("price") ||
      q.includes("prices") ||
      q.includes("membership") ||
      q.includes("bundle") ||
      q.includes("what is included");

    // 👇 3) Cualquier combinación de lo anterior dispara el motor de catálogo
    const isCatalogQuestion = isCatalogQuestionBasic || isCombinationIntent;

    if (!isCatalogQuestion) {
      // deja continuar con el resto del fastpath
    } else {
      const isPriceLike =
        isPriceQuestion(userInput) ||
        q.includes("plan") ||
        q.includes("planes") ||
        q.includes("membresia") ||
        q.includes("membresía") ||
        q.includes("membership") ||
        q.includes("paquete") ||
        q.includes("package") ||
        q.includes("bundle");

      const isAskingOtherPlans =
        /\b(otro\s+plan|otros\s+planes|otras\s+opciones|other\s+plans?|more\s+plans?)\b/.test(q);

      type QuestionType = "combination_and_price" | "price_or_plan" | "other_plans";

      let questionType: QuestionType;

      // PRIORIDAD:
      // 1) Pregunta de combinación, aunque no diga "precio"
      if (isCombinationIntent) {
        questionType = "combination_and_price";
      }
      // 2) Pregunta explícita de "otros planes"
      else if (isAskingOtherPlans) {
        questionType = "other_plans";
      }
      // 3) Resto: preguntas normales de precio/plan
      else {
        questionType = "price_or_plan";
      }

      const asksSchedules =
        /\b(horario|horarios|hora|horas|hours?|schedule|schedules)\b/i.test(q);
      const catalogText = await buildCatalogContext(pool, tenantId);

      const hasMultiAccessPlan =
        /todas las clases|todas nuestras clases|todas las sesiones|all classes|all services|any class|unlimited/i.test(
          catalogText
        );

      // ✅ construir PREVIOUS_PLANS_MENTIONED desde el contexto
      const nowForMeta = Date.now();
      let previousPlansStr = "none";
      const prevNames = Array.isArray(convoCtx?.last_catalog_plans)
        ? convoCtx.last_catalog_plans!
        : [];
      const prevAtRaw = (convoCtx as any)?.last_catalog_at;
      const prevAt = Number(prevAtRaw);
      const prevFresh =
        prevNames.length > 0 &&
        Number.isFinite(prevAt) &&
        prevAt > 0 &&
        nowForMeta - prevAt <= 30 * 60 * 1000; // 30 minutos

      if (prevFresh) {
        previousPlansStr = prevNames.join(" | ");
      }

      const metaBlock =
        `QUESTION_TYPE: ${questionType}\n` +
        `HAS_MULTI_ACCESS_PLAN: ${hasMultiAccessPlan ? "yes" : "no"}\n` +
        `PREVIOUS_PLANS_MENTIONED: ${previousPlansStr}`;

      // ⚖️ Solo adjuntar horarios / info general cuando:
      // - el usuario menciona horarios/horas/schedule, o
      // - la intención es info_general / info_horarios_generales
      const shouldAttachInfoGeneral =
        !!infoClave &&
        (asksSchedules ||
          intentOut === "info_general" ||
          intentOut === "info_horarios_generales");

      const infoGeneralBlock = shouldAttachInfoGeneral
        ? idiomaDestino === "en"
          ? `\n\nBUSINESS_GENERAL_INFO (hours, address, etc.):\n${infoClave}`
          : `\n\nINFO_GENERAL_DEL_NEGOCIO (horarios, dirección, etc.):\n${infoClave}`
        : "";

      const systemMsg =
        idiomaDestino === "en"
          ? `
      You are Aamy, a sales assistant for a multi-tenant SaaS.

      You receive:
      - A META section with high-level tags.
      - Optionally a PREVIOUS_PLANS_MENTIONED line.
      - The client's question.
      - A CATALOG text for this business, built from the "services" and "service_variants" tables.
      - Optionally, a BUSINESS_GENERAL_INFO block with general information such as business hours, address, schedules, etc.

      META TAGS:
      - QUESTION_TYPE can be "combination_and_price", "price_or_plan", or "other_plans".
      - HAS_MULTI_ACCESS_PLAN is "yes" if the catalog text clearly contains at least one plan/pass/bundle that gives access to multiple services/categories or to "all"/"any"; otherwise "no".
      - PREVIOUS_PLANS_MENTIONED tells you which plans have ALREADY been described. If "none", ignore it; otherwise avoid repeating them unless necessary.

      GLOBAL RULES:
      - Answer ONLY using information found in the CATALOG and BUSINESS_GENERAL_INFO blocks.
      - Do NOT invent prices, services, bundles or conditions.
      - Be clear, natural, and concise.
      - Intro lines:
        - You may use up to TWO very short intro lines (greeting + context) ONLY if PREVIOUS_PLANS_MENTIONED is "none".
        - If PREVIOUS_PLANS_MENTIONED is NOT "none" (follow-up questions), you MUST NOT include any greeting or intro line. Start directly with the list or detail.
      - Apart from those intro lines (when allowed) and an optional closing question/CTA, EVERYTHING must be bullet-listed.
      - NEVER write long paragraphs.

      IMPORTANT FORMAT RULE:
      - For each plan/service/product you MUST write EXACTLY ONE line:
        • “• Plan name: price summary”
      - After the colon ":" you may include ONLY a short price summary:
        - numbers,
        - currency symbols,
        - short terms like “from”, “per”, “USD/month”, “USD for 7 days”,
        - short conditions like “(autopay, 3 months)”.
      - It is FORBIDDEN to add descriptive text such as: access, unlimited, classes, during, ideal for, includes, suitable for, etc.
      - If the catalog contains a plan name followed by a long description, extract ONLY:
        - the name,
        - the price.
      - Benefits/inclusions can ONLY be used later in DETAIL MODE.

      QUANTITY RULE (MANDATORY):
      - In LISTING MODE, you MUST show ONLY 3 to 7 options.
      - It is STRICTLY FORBIDDEN to list all catalog items.
      - If the catalog contains more than 7 items, select only the most relevant:
        - representative price points,
        - most common plans,
        - or those best matching the user's intent.
      - NEVER show more than 7 bullets.
      - If a plan has multiple variants (autopay vs monthly, etc.), show ONLY ONE in the initial list. Other variants can only be shown if the client asks about that specific plan.

      NEUTRAL LIST INTRO:
      - When listing plans, NEVER say “Main plans”, “Featured plans”, “All plans”, etc.
      - ALWAYS use a neutral phrase indicating these are partial options:
        - “Some of our plans:”
        - “Here are a few options:”
        - “A few choices below:”
      - NEVER imply the list is exhaustive.

      HANDLING TIMES & SCHEDULES:
      - Business hours and general schedules appear in BUSINESS_GENERAL_INFO.
      - You may use explicit times from BUSINESS_GENERAL_INFO.
      - DO NOT generalize or invent ranges.
      - If BUSINESS_GENERAL_INFO contains multiple time slots, copy them EXACTLY as bullet points (one per line).
      - If there are NO explicit times, you may add ONE generic line without time-of-day words, for example:
        - Do NOT mention schedules or hours at all.
      - If CATALOG mentions time restrictions, treat them ONLY as plan-specific restrictions.

      LISTING MODE:
      - Use LISTING MODE when the user asks generically (“plans?”, “options?”, “plans and schedules?”).
      - In LISTING MODE:
        - Max 3–7 bullets.
        - EXACT format: “• Plan name: price summary”.
        - No descriptions allowed.
        - Only ONE link, for the most relevant option.
        - No paragraphs.
      - HANDLING PREVIOUS_PLANS_MENTIONED:
      - If PREVIOUS_PLANS_MENTIONED is not "none", you MUST treat this as a follow-up question like "what other plans do you have?".
      - In that case:
        - FIRST, try to list ONLY plans/passes/products that are NOT in PREVIOUS_PLANS_MENTIONED.
        - Select 3–7 items among those “new” plans, following the quantity rules.
        - If there are fewer than 3 new items available, you may:
          - list all remaining new ones, and
          - optionally add 1–2 previously mentioned plans, clearly marking that they were already mentioned.
      - Under no circumstances should you repeat exactly the same list of plans as before when PREVIOUS_PLANS_MENTIONED includes those items.
      - PRICE / PLAN QUESTIONS:
        - Always list plans in bullet format.
        - If several options are relevant, compare them using separate bullets.
        - When you list several options, you MUST order them from the lowest total price to the highest total price.
        - Plans or products with price 0 must be written as "free" (for example: "free" instead of "0 USD" or "0.00").

      DETAIL MODE:
      - Use DETAIL MODE only when the user asks about ONE specific plan.
      - STILL use bullets:
        - one bullet with name + price,
        - 1–3 sub-bullets with key details.
      - Keep it compact.

      PRICE / PLAN QUESTIONS:
      - Always list plans in bullet format.
      - If several options are relevant, compare them using separate bullets.
      
      COMBINATIONS / BUNDLES:
      - If QUESTION_TYPE is "combination_and_price" AND HAS_MULTI_ACCESS_PLAN is "yes":
        - You MUST recommend at least one plan that covers multiple services/categories or unlimited usage.
        - Mention name + price + URL if available.
      - If HAS_MULTI_ACCESS_PLAN is "no":
        - You may list individual services separately (in bullets).

      OUTPUT LANGUAGE:
      - Answer always in English.
      `.trim()
          : `
      Eres Aamy, asistente de ventas de una plataforma SaaS multinegocio.

      Recibes:
      - Una sección META con etiquetas de alto nivel.
      - Opcionalmente una línea PREVIOUS_PLANS_MENTIONED.
      - La pregunta del cliente.
      - Un texto de CATALOGO del negocio (services + service_variants).
      - Opcionalmente, un bloque INFO_GENERAL_DEL_NEGOCIO con horarios, dirección, etc.

      ETIQUETAS META:
      - QUESTION_TYPE puede ser "combination_and_price", "price_or_plan" o "other_plans".
      - HAS_MULTI_ACCESS_PLAN es "yes" si el catálogo contiene un plan/pase que dé acceso a varias categorías o a “todos”; si no, "no".
      - PREVIOUS_PLANS_MENTIONED indica qué planes YA se mencionaron.

      REGLAS GENERALES:
      - Responde SOLO con la información de CATALOGO e INFO_GENERAL_DEL_NEGOCIO.
      - NO inventes precios, servicios ni condiciones.
      - Líneas de introducción:
        - Solo puedes usar HASTA DOS líneas muy cortas al inicio (saludo + contexto) cuando PREVIOUS_PLANS_MENTIONED sea "none".
        - Si PREVIOUS_PLANS_MENTIONED NO es "none" (es decir, ya se mencionaron planes antes y la pregunta es un seguimiento), está PROHIBIDO usar saludo o introducción. Debes empezar directamente con la lista o el detalle.
      - Cada una de esas líneas (cuando estén permitidas) debe ser muy corta (1 oración); no escribas párrafos de bienvenida.
      - PROHIBIDO escribir párrafos largos.

      FORMATO DE PLANES (OBLIGATORIO):
      - Cada plan/pase/producto debe ir en UNA sola línea:
        • “• Nombre del plan: resumen de precio”.
      - Después de ":" SOLO puede ir un resumen de precio:
        - números,
        - símbolo de moneda,
        - palabras muy cortas: “desde”, “por”, “USD/mes”, “USD por 7 días”,
        - condiciones cortas: “(Autopay, 3 meses)”, “(sin compromiso)”.
      - PROHIBIDO agregar descripciones:
        - “acceso”, “ilimitado”, “clases”, “durante”, “ideal para…”, etc.
      - Si el nombre del plan viene con descripción, usa SOLO:
        - nombre,
        - precio.
      - Los beneficios/inclusiones SOLO se pueden mencionar en MODO DETALLE.

      REGLA DE CANTIDAD (OBLIGATORIA):
      - En MODO LISTA solo se pueden mostrar entre 3 y 7 opciones.
      - Está TOTALMENTE PROHIBIDO listar TODO el catálogo.
      - Si hay más de 7, elige solo las opciones más relevantes:
        - precios representativos,
        - planes más comunes,
        - o los que responden mejor a la intención del usuario.
      - JAMÁS muestres más de 7 ítems.
      - Si un plan tiene varias variantes (Autopay / Mensual / Paquete), SOLO muestra UNA.
      - Otras variantes solo pueden mostrarse si el cliente pregunta específicamente por ese plan.

      FRASES NEUTRAS PARA LISTAS:
      - NO digas “Planes principales”, “Planes destacados”, “Todos los planes”, etc.
      - Debes usar SIEMPRE frases neutras que indiquen que solo muestras una parte:
        - “Algunos de nuestros planes:”
        - “Aquí tienes algunas opciones:”
        - “Estas son algunas alternativas:”
      - Nunca sugieras que la lista es completa.

      CÓMO MANEJAR HORARIOS:
      - Si INFO_GENERAL_DEL_NEGOCIO contiene horarios explícitos:
        - Cópialos EXACTAMENTE como lista, uno por línea.
        - PROHIBIDO resumir (“en varios horarios”, “de mañana a noche”).
      - Si NO contiene horarios:
        - NO menciones horarios ni hagas comentarios genéricos sobre horarios.
      - Si el CATALOGO tiene restricciones horarias, aplícalas SOLO a ese plan.

      MODO LISTA:
      - Se usa cuando la pregunta es general.
      - Debes:
        - mostrar 3–7 opciones,
        - usar exactamente “• Nombre del plan: precio”,
        - NO poner descripciones,
        - NO poner variantes extras,
        - NO poner párrafos,
        - incluir SOLO UN enlace (si aplica).
      - MANEJO DE PREVIOUS_PLANS_MENTIONED:
        - Si PREVIOUS_PLANS_MENTIONED no es "none", debes entender que el cliente está pidiendo "otros planes" o un seguimiento.
        - En ese caso:
          - PRIMERO intenta listar SOLO planes/pases/productos que NO aparezcan en PREVIOUS_PLANS_MENTIONED.
          - Elige entre 3 y 7 de esos planes “nuevos”, respetando las reglas de cantidad.
          - Si hay menos de 3 planes nuevos disponibles:
            - muestra todos los nuevos,
            - y solo si es necesario añade 1–2 planes que ya se mencionaron, dejando claro que ya se habían comentado antes.
        - Bajo ninguna circunstancia debes repetir exactamente la misma lista de planes que ya se mostró cuando PREVIOUS_PLANS_MENTIONED contiene esos mismos nombres.
      - PRECIOS / SERVICIOS:
        - Siempre usa listas.
        - Comparaciones → una viñeta por opción.
        - Cuando muestres varias opciones, DEBES ordenarlas de menor a mayor precio total.
        - Si un plan o producto tiene precio 0, debes escribir "gratis" (por ejemplo: "gratis" en lugar de "0 USD" o "0.00").

      MODO DETALLE:
      - Se usa cuando el cliente pide info de un plan específico.
      - Igual en viñetas:
        - una línea principal con nombre + precio,
        - 1–3 subviñetas con detalles concretos.
      - Sin párrafos largos.

      PRECIOS / SERVICIOS:
      - Siempre usa listas.
      - Comparaciones → una viñeta por opción.

      COMBINADOS / PAQUETES:
      - Si QUESTION_TYPE = "combination_and_price" y HAS_MULTI_ACCESS_PLAN = "yes":
        - Debes recomendar un plan que cubra varias categorías o acceso amplio.
        - Incluye precio y URL si está en catálogo.
      - Si HAS_MULTI_ACCESS_PLAN = "no":
        - Puedes listar servicios individuales.

      IDIOMA DE SALIDA:
      - Responde siempre en español.
      `.trim();

      const userMsg =
        idiomaDestino === "en"
          ? `
META:
${metaBlock}

CLIENT QUESTION:
${userInput}

CATALOG:
${catalogText}${infoGeneralBlock}
`.trim()
          : `
META:
${metaBlock}

PREGUNTA DEL CLIENTE:
${userInput}

CATALOGO:
${catalogText}${infoGeneralBlock}
`.trim();

      const rawReply = await answerCatalogQuestionLLM({
        idiomaDestino,
        systemMsg,
        userMsg,
      });

      // 🔁 POST-PROCESO: quitar planes ya mencionados si la pregunta es "otros planes"
      const { finalReply, namesShown } = postProcessCatalogReply({
        reply: rawReply,
        questionType,
        prevNames,
      });

      // 🔧 limpiamos frases de "enlace / links / comprar en los enlaces"
      const cleanedReply = stripLinkSentences(finalReply);

      // 🌎 NUEVO: aseguramos que TODO el catálogo salga en el idiomaDestino
      let localizedReply = cleanedReply;

      if (idiomaDestino === "en") {
        try {
          // tu helper actual: traducir TODO el bloque al inglés,
          // incluyendo nombres de planes/productos.
          localizedReply = await traducirTexto(cleanedReply, "en");
        } catch (e: any) {
          console.warn(
            "[FASTPATH][CATALOG] error traduciendo respuesta de catálogo:",
            e?.message || e
          );
        }
      }
      // si en el futuro agregas más idiomas, aquí puedes meter más ramas:
      // else if (idiomaDestino === "es") { ... }

      const ctxPatch: Partial<FastpathCtx> = {};
      if (namesShown.length) {
        ctxPatch.last_catalog_plans = namesShown;
        ctxPatch.last_catalog_at = Date.now();
      }

      return {
        handled: true,
        // usamos la versión traducida
        reply: humanizeListReply(localizedReply, idiomaDestino),
        source: "catalog_llm",
        intent: intentOut || "catalog",
        ctxPatch,
      };
    }
  }

  return { handled: false };
}