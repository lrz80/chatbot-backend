// backend/src/lib/fastpath/runFastpath.ts
import type { Pool } from "pg";

import type { Canal } from "../detectarIntencion";
import type { Lang } from "../channels/engine/clients/clientDb";

import { detectarIdioma } from "../detectarIdioma";
import { traducirMensaje } from "../traducirMensaje";

// INFO_CLAVE includes
import {
  isAskingIncludes,
  findServiceBlock,
  extractIncludesLine,
  normalizeText,
} from "../infoclave/resolveIncludes";

// DB catalog includes
import {
  resolveServiceInfo,          // si ya lo usas
  getServiceDetailsText,       // 👉 añade esto
} from "../services/resolveServiceInfo";

// Pricing
import { getPriceInfoForService } from "../services/pricing/getFromPriceForService";
import { resolveServiceIdFromText } from "../services/pricing/resolveServiceIdFromText";
import { renderPriceReply } from "../services/pricing/renderPriceReply";
import { isGenericPriceQuestion } from "../services/pricing/isGenericPriceQuestion";
import { renderGenericPriceSummaryReply } from "../services/pricing/renderGenericPriceSummaryReply";
import { resolveServiceList } from "../services/resolveServiceList";
import { renderServiceListReply } from "../services/renderServiceListReply";
import { resolveBestLinkForService } from "../links/resolveBestLinkForService";
import { renderInfoGeneralOverview } from "../fastpath/renderInfoGeneralOverview";
import { filterRowsByMeaningfulTokens } from "../services/pricing/priceSummaryTokens";
import { getServiceAndVariantUrl } from "../services/getServiceAndVariantUrl";
import { buildCatalogContext } from "../catalog/buildCatalogContext";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

// Tipo inferido del helper real (sin duplicar tipos)
type PriceInfo = Awaited<ReturnType<typeof getPriceInfoForService>>;

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

  [k: string]: any;
};

export type FastpathAwaitingEffect =
  | {
      type: "set_awaiting_yes_no";
      ttlSeconds: number;
      payload: any;
    }
  | { type: "none" };

export type FastpathResult =
  | {
      handled: true;
      reply: string;
      source:
        | "service_list_db" // ✅ ADD
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
        | "catalog_llm";
      intent: string | null;
      ctxPatch?: Partial<FastpathCtx>;
      awaitingEffect?: FastpathAwaitingEffect;
      fastpathHint?: FastpathHint;          // 👈 NUEVO
    }
  | {
      handled: false;
      ctxPatch?: Partial<FastpathCtx>;
      fastpathHint?: FastpathHint;          // opcional también aquí
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

export type FastpathHint =
  | {
      type: "price_summary";
      payload: {
        lang: Lang;
        rows: { service_name: string; min_price: number; max_price: number }[];
      };
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
  items: Array<{ id: string; name: string; url: string | null }>
) {
  const u = normalizeText(userText);
  if (!u) return null;

  // match por inclusión (simple y multitenant)
  // si el usuario escribe "bronze cycling" o "plan bronze", etc.
  const hits = items.filter((it) => {
    const n = normalizeText(it.name);
    return n.includes(u) || u.includes(n);
  });

  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    // si hay varios, elige el que tenga nombre más largo (más específico)
    return hits.sort((a, b) => normalizeText(b.name).length - normalizeText(a.name).length)[0];
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
  const hasTryVerb   = /\b(probar|try|testear|probarla|probarlo)\b/i.test(t);

  // Caso A: explícitamente gratis + señal de prueba
  if (hasFreeWord && (hasTrialWord || hasClassWord)) return true;

  // Caso B: verbo de "probar" + palabra de clase, aunque no diga "gratis"
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

// Tipos aceptados para "plan/paquete" (schema-level, no negocio)
function isPlanPackageType(tipo: any) {
  const t = norm(tipo);
  return (
    t === "plan" ||
    t === "plans" ||
    t === "plan/paquete" ||
    t === "plan / paquete" ||
    t === "plan_paquete" ||
    t === "plan-paquete" ||
    t === "planpackage" ||
    t === "plan_package"
  );
}

function isPackageCategory(cat: any) {
  const c = norm(cat);
  return (
    c === "package" ||
    c === "packages" ||
    c === "paquete" ||
    c === "paquetes" ||
    c === "bundle" ||
    c === "bundles" ||
    c === "pack" ||
    c === "packs"
  );
}

function isMembershipCategory(cat: any) {
  const c = norm(cat);
  return (
    c === "membresia" ||
    c === "membresias" ||
    c === "membership" ||
    c === "memberships" ||
    c === "monthly" ||
    c === "mensual" ||
    c === "mensuales"
  );
}

function isPlansOrPackagesQuestion(text: string) {
  const t = norm(text);
  return /\b(plan|planes|membresia|membresias|membership|memberships|monthly|mensual|paquete|paquetes|package|packages|bundle|bundles|pack|packs)\b/.test(
    t
  );
}

function sectionTitle(lang: Lang, key: "plans" | "packages") {
  if (lang === "en") {
    return key === "plans"
      ? "Here are some of our available plans:"
      : "Here are some of our available packages:";
  }

  return key === "plans"
    ? "Aquí tienes algunos de nuestros planes:"
    : "Aquí tienes algunos de nuestros paquetes:";
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

function isInterestMessage(raw: string): boolean {
  const t = (raw || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

  // Verbos de interés genéricos, multi-industria
  const patterns = [
    /\bme interesa\b/,
    /\bme interesan\b/,
    /\bme llam[aá] la atencion\b/,
    /\bquiero\b/,
    /\bquisiera\b/,
    /\bme gustar[ií]a\b/,
    /\bme gusta(n)?\b/,
    /\bcreo que tomar[ií]a\b/,
  ];

  return patterns.some((re) => re.test(t));
}

function finalize(
  reply: string,
  intent: string | null,
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
): FastpathResult {
  return {
    handled: true,
    reply,
    source,
    intent,
  };
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

  // Fastpath solo aplica si NO estás en booking
  if (inBooking) return { handled: false };

  const intentOut = (detectedIntent || "").trim() || null;

  // ===============================
  // ✅ INFO GENERAL OVERVIEW (NO ASK)
  // ===============================
  if (intentOut === "info_general") {
    // Solo limpiar cosas de "listas" (no toques awaiting global)
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
  // ✅ PICK FROM LAST LIST -> SEND SINGLE LINK (NO HARDCODE)
  // ===============================
  {
    const ttlMs = 5 * 60 * 1000;

    const planList = Array.isArray(convoCtx?.last_plan_list) ? convoCtx.last_plan_list : [];
    const planAtRaw = (convoCtx as any)?.last_plan_list_at;
    const planAt = Number(planAtRaw);
    const planAtOk = Number.isFinite(planAt) && planAt > 0;

    // ✅ si hay lista pero NO hay timestamp válido, asumimos fresh (self-heal)
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

    // ✅ si hay kind pero no timestamp válido, también lo consideramos fresh
    const kindFresh = Boolean(kind) && (!kindAtOk || Date.now() - kindAt <= ttlMs);

    // 🔎 debug fuerte
    console.log("🧪 PICK CHECK", {
      userInput,
      planLen: planList.length,
      planAtRaw,
      planAt,
      planFresh,
      pkgLen: pkgList.length,
      pkgAtRaw,
      pkgAt,
      pkgFresh,
      kind,
      kindAtRaw,
      kindAt,
      kindFresh,
    });

    const healPatch: Partial<FastpathCtx> = {};

    if (planList.length > 0 && !planAtOk) healPatch.last_plan_list_at = Date.now();
    if (pkgList.length > 0 && !pkgAtOk) healPatch.last_package_list_at = Date.now();
    if (kind && !kindAtOk) healPatch.last_list_kind_at = Date.now();

    if (planFresh || pkgFresh) {
      // 🛑 1) Si el mensaje es de "clase de prueba", NO usamos este flujo
      if (isTrialQuery(userInput)) {
        console.log("🧪 PICK SKIP — trial/demo query, dejar a otras reglas manejarlo");
      } else {
        // 🧮 índice tipo "1", "2", etc.
        const idx = (() => {
          const t = String(userInput || "").trim();
          const m = t.match(/^([1-9])$/); // ✅ SOLO si el user manda "1" (y nada más)
          return m ? Number(m[1]) : null;
        })();

        const msgNorm = normalizeText(userInput);

        // 🧠 ¿menciona explícitamente algún plan/paquete de la última lista?
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

        // 🛑 2) Si el usuario NO mandó número NI mencionó un item de la lista,
        // no hacemos pick y dejamos que otras reglas (precio, trial, etc.) actúen.
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
            if (!picked) picked = bestNameMatch(userInput, list);

            return picked ? { ...picked, kind } : null;
          };

          // ✅ prioridad por “último tipo listado” si está fresco
          let picked: ({ id: string; name: string; url: string | null; kind: "plan" | "package" }) | null = null;

          if (kindFresh && kind === "package") {
            if (pkgFresh) picked = tryPick(pkgList, "package");
            if (!picked && planFresh) picked = tryPick(planList, "plan");
          } else {
            if (planFresh) picked = tryPick(planList, "plan");
            if (!picked && pkgFresh) picked = tryPick(pkgList, "package");
          }

          if (picked) {
            // ✅ Si viene de lista de opciones (id compuesto), separar serviceId real
            const rawPickedId = String(picked.id || "");
            const parts = rawPickedId.split("::");
            const pickedServiceId = parts[0] || rawPickedId; // ✅ siempre termina siendo UUID real
            const pickedOptionLabel = parts.length > 1 ? parts.slice(1).join("::") : null; // por si label trae ::

            const basePatch: Partial<FastpathCtx> = {
              // limpiar listas tras elegir (evita loops)
              last_plan_list: undefined,
              last_plan_list_at: undefined,
              last_package_list: undefined,
              last_package_list_at: undefined,
              last_list_kind: undefined,
              last_list_kind_at: undefined,

              // ✅ CANÓNICO: qué fue lo último seleccionado (sirve para "precio" luego)
              last_selected_kind: picked.kind, // "plan" | "package"
              last_selected_id: picked.id,
              last_selected_name: picked.name,
              last_selected_at: Date.now(),

              // ✅ set last_service REAL para price/includes
              last_service_id: pickedServiceId,
              last_service_name: picked.name, // (nombre mostrado, puede ser label)
              last_service_at: Date.now(),

              // ✅ opcional pero recomendado: guardar la opción elegida para el siguiente “precio”
              last_price_option_label: pickedOptionLabel,
              last_price_option_at: Date.now(),
            };

            // ✅ NO HARDCODE:
            // - si picked.url existe úsalo (service_url guardado en lista)
            // - si no, intenta resolver el mejor link desde DB (service_url o variant_url)
            // - si hay varios (ambiguous), abre pending_link_lookup con labels reales del tenant
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

            const d = await getServiceDetailsText(tenantId, pickedServiceId, userInput).catch(() => null);

            const baseName = String(convoCtx?.last_service_name || "") || String(picked.name || "");
            const title = d?.titleSuffix ? `${baseName} — ${d.titleSuffix}` : baseName;

            const infoText = d?.text ? String(d.text).trim() : "";

            // Si aún no hay URL, intenta 1 vez más resolver link usando el mismo userInput (ej: "autopay")
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
                ? `${title}${infoText ? `\n\n${infoText}` : ""}${finalUrl ? `\n\nHere’s the link:\n${finalUrl}` : ""}`
                : `${title}${infoText ? `\n\n${infoText}` : ""}${finalUrl ? `\n\nAquí está el link:\n${finalUrl}` : ""}`;

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
  // ✅ ANTI-LOOP: clear pending_link if user changed topic
  // (NO HARDCODE: only matches against pending_link_options labels)
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

    // Si expiró TTL, limpia y sigue normal
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
      const norm = (s: string) =>
        String(s || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .trim();

      const tNorm = norm(userInput);

      // Cancel genérico (esto NO es hardcode de negocio)
      const looksLikeCancel =
        /\b(no|no\s+gracias|gracias|thanks|cancelar|olvidalo|olvidalo|stop)\b/.test(tNorm);

      // (A) si responde con número (1,2,3) es claramente una opción
      const idx = (() => {
        const m = tNorm.match(/^([1-9])$/); // ✅ solo si el mensaje es SOLO "1"
        if (!m) return null;
        const n = Number(m[1]);
        return Number.isFinite(n) ? n : null;
      })();

      const looksLikeOptionByIndex =
        idx != null && idx >= 1 && idx <= Math.min(9, pendingOptions.length);

      // (B) match por palabras del label (evita depender de escribir el label completo)
      const labelWordHit = pendingOptions.some((o: any) => {
        const labelNorm = norm(o?.label || "");
        if (!labelNorm) return false;

        // Palabras del label con longitud razonable
        const words = labelNorm.split(/\s+/).filter((w) => w.length >= 3);

        // Si el usuario escribió alguna palabra clave del label
        return words.some((w) => tNorm.includes(w));
      });

      const looksLikeOptionAnswer = looksLikeOptionByIndex || labelWordHit;

      // Si canceló, o cambió de tema (no parece opción) -> limpia pending y deja seguir pipeline
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

      // Si parece opción, NO limpies aquí; deja que el bloque "RESOLVE PENDING LINK"
      // lo capture y envíe el link correcto.
    }
  }

  // ===============================
  // ✅ FREE OFFER (DB) -> LIST OPTIONS THEN PICK -> SEND LINK
  // ===============================
  {
    const wantsFreeOffer = isFreeOfferQuestion(userInput);

    if (wantsFreeOffer) {
      // Servicios gratis del tenant (price_base=0) con URL directa
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

      // Si no hay nada gratis con URL, no inventes "portal": pide especificación genérica
      if (!items.length) {
        const msg =
          idiomaDestino === "en"
            ? "Yes — we can help with a free/trial option 😊 What exactly are you looking for?"
            : "Sí — podemos ayudarte con una opción gratis/de prueba 😊 ¿Qué estás buscando exactamente?";
        return { handled: true, reply: msg, source: "service_list_db", intent: "free_offer" };
      }

      // Si hay 1 sola opción gratis: manda directo el link de ESA opción
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

      // Si hay 2+ opciones: lista y deja que el PICK FROM LAST LIST resuelva
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
          // reutilizamos tu mecanismo de pick: guardamos en last_plan_list (es solo una lista de selección)
          last_plan_list: items.map((x) => ({ id: x.id, name: x.name, url: x.url })),
          last_plan_list_at: Date.now(),
          last_list_kind: "plan",
          last_list_kind_at: Date.now(),
        },
      };
    }
  }

  // ===============================
  // ✅ INTEREST -> SEND BEST LINK (service_url or variant_url)
  // ===============================
  {
    const t = String(userInput || "").trim();

    const tNorm = normalizeText(userInput);

    // intención genérica de “quiero link / web / comprar”, sin copy hardcode
    const wantsLink =
      /\b(link|enlace|url|web|website|sitio|pagina|página|comprar|buy|pagar|checkout)\b/i.test(tNorm);

    const pending = Boolean(convoCtx?.pending_link_lookup);

    // ✅ Si ya acabamos de mandar "info + link" por PICK, no repetir aquí
    const lastAct = String(convoCtx?.last_bot_action || "");
    const lastActAt = Number(convoCtx?.last_bot_action_at || 0);
    const justSentDetails = lastAct === "sent_details" && lastActAt > 0 && Date.now() - lastActAt < 2 * 60 * 1000;

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

        // ✅ Trae descripción: intenta variante por texto ("por mes", "autopay"), si no servicio
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
            ? `${title ? `${title}\n\n` : ""}${infoText ? `${infoText}\n\n` : ""}Here it is 😊\n${pick.url}\n\n${outro}`
            : `${title ? `${title}\n\n` : ""}${infoText ? `${infoText}\n\n` : ""}Aquí lo tienes 😊\n${pick.url}\n\n${outro}`;

          // ===============================
          // 🔗 LINK DEL SERVICIO / VARIANTE
          // ===============================
          const variantId =
            (convoCtx as any)?.last_variant_id
              ? String((convoCtx as any).last_variant_id)
              : null;

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
        // 1 sola pregunta corta, sin menús numéricos
        const labels = pick.options
          .slice(0, 3)
          .map((o) => o.label)
          .filter(Boolean);

        const q =
          idiomaDestino === "en"
            ? `Sure 😊 Which option do you want— ${labels.join(" or ")}?`
            : `Perfecto 😊 ¿Cuál opción quieres— ${labels.join(" o ")}?`;

        // opcional: guarda para que el próximo mensaje “autopay” resuelva directo
        return {
          handled: true,
          reply: q,
          source: "service_list_db",
          intent: intentOut || "link",
          ctxPatch: {
            pending_link_lookup: true,
            pending_link_at: Date.now(),
            pending_link_options: pick.options, // si tu ctx permite JSON; si no, omítelo
          } as any,
        };
      }
    }
  }

  // =========================================================
  // ✅ FOLLOW-UP ROUTER (mantener hilo conversacional)
  // - si el usuario manda un mensaje corto / follow-up,
  //   intentamos resolver usando: pending flags + last list + last service
  // =========================================================
  {
    const t = String(userInput || "").trim();
    const tLower = t.toLowerCase();

    const isShort =
      t.length > 0 &&
      t.length <= 22 &&                 // ajustable
      !t.includes("?") &&
      !/\b(hola|hi|hello|gracias|thanks)\b/i.test(tLower);

    const now = Date.now();

    const ttlMs = 10 * 60 * 1000;

    // helpers de frescura
    const fresh = (at: any) => {
      const n = Number(at || 0);
      return Number.isFinite(n) && n > 0 && now - n <= ttlMs;
    };

    const pendingPrice = Boolean((convoCtx as any)?.pending_price_lookup) && fresh((convoCtx as any)?.pending_price_at);
    const pendingLink  = Boolean((convoCtx as any)?.pending_link_lookup)  && fresh((convoCtx as any)?.pending_link_at);

    const lastServiceId = String((convoCtx as any)?.last_service_id || "").trim();
    const lastServiceFresh = lastServiceId && fresh((convoCtx as any)?.last_service_at);

    const planList = Array.isArray((convoCtx as any)?.last_plan_list) ? (convoCtx as any).last_plan_list : [];
    const pkgList  = Array.isArray((convoCtx as any)?.last_package_list) ? (convoCtx as any).last_package_list : [];
    const listFresh =
      (planList.length && fresh((convoCtx as any)?.last_plan_list_at)) ||
      (pkgList.length  && fresh((convoCtx as any)?.last_package_list_at));

    // 1) Si estamos esperando aclaración de LINK y el user manda algo corto -> tratar como pick
    if (isShort && pendingLink && Array.isArray((convoCtx as any)?.pending_link_options) && (convoCtx as any).pending_link_options.length) {
      // Reutiliza tu bestNameMatch sobre options.label
      const opts = (convoCtx as any).pending_link_options;
      const pick = bestNameMatch(t, opts.map((o: any) => ({ name: o.label })));

      if (pick?.name) {
        // deja que tu lógica existente de resolveBestLinkForService se ejecute luego
        // solo limpia pending para evitar loops y marca last_bot_action
        return {
          handled: false, // seguimos el flujo normal, pero con ctxPatch para limpiar pending y no perder hilo
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

    // 2) Si el user manda algo corto y hay una lista fresca -> deja que PICK FROM LAST LIST lo capture
    if (isShort && listFresh) {
      // no hacemos nada aquí: tu bloque PICK ya lo maneja
    } else {
      // 3) Si el user manda algo corto y estamos en pending_price_lookup -> resolver como servicio
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

      // 4) Si el user manda algo corto y existe last_service_id fresco -> interpretarlo como “seguir hablando de eso”
      if (isShort && lastServiceFresh) {
        // si el texto parece una opción (autopay / monthly / etc), guárdalo como preferencia
        // (no hardcode: solo guardamos label)
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
  // 🧠 MOTOR ÚNICO DE CATÁLOGO (services + service_variants)
  // ===============================
  {
    // 1) ¿Es una pregunta de catálogo?
    const isCatalogQuestion =
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
      q.includes("combinar") ||
      q.includes("mezclar") ||
      q.includes("usar ambas") ||
      q.includes("usar las dos") ||
      q.includes("unlimited") ||
      q.includes("ilimitado") ||
      q.includes("pack") ||
      q.includes("paquete") ||
      q.includes("autopay") ||
      // inglés
      q.includes("price") ||
      q.includes("prices") ||
      q.includes("membership") ||
      q.includes("bundle") ||
      q.includes("combine classes") ||
      q.includes("what is included");

    if (!isCatalogQuestion) {
      // deja continuar con el resto del fastpath
    } else {
      // 2) Clasificar tipo de pregunta para META
      const isCombinationIntent =
        q.includes("combinar") ||
        q.includes("mezclar") ||
        q.includes("usar ambas") ||
        q.includes("usar las dos") ||
        q.includes("combine classes") ||
        q.includes("use both");

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
        /\b(otro\s+plan|otros\s+planes|other\s+plans?)\b/.test(q);

      type QuestionType = "combination_and_price" | "price_or_plan" | "other_plans";

      let questionType: QuestionType = "price_or_plan";
      if (isCombinationIntent && isPriceLike) {
        questionType = "combination_and_price";
      } else if (isAskingOtherPlans) {
        questionType = "other_plans";
      }

      // 3) Construir el texto de catálogo
      const catalogText = await buildCatalogContext(pool, tenantId);
      console.log("🧾 CATALOGO DEBUG\n", catalogText);

      // 4) Detectar si el catálogo tiene algún plan que claramente da acceso a varias cosas
      const hasMultiAccessPlan = /todas las clases|todas nuestras clases|todas las sesiones|all classes|all services|any class|unlimited/i.test(
        catalogText
      );

      const metaBlock =
        `QUESTION_TYPE: ${questionType}\n` +
        `HAS_MULTI_ACCESS_PLAN: ${hasMultiAccessPlan ? "yes" : "no"}`;

      // 5) System message (el que ya ajustamos antes)
      const systemMsg =
        idiomaDestino === "en"
          ? `
You are Aamy, a sales assistant for a multi-tenant SaaS.

You receive:
- A META section with high-level tags.
- The client's question.
- A CATALOG text for this business, built from the "services" and "service_variants" tables.

META TAGS:
- QUESTION_TYPE can be "combination_and_price", "price_or_plan" or "other_plans".
- HAS_MULTI_ACCESS_PLAN is "yes" if the catalog text clearly contains at least one plan/pass/bundle that gives access to multiple services/categories or to "all"/"any" services; otherwise "no". (The value is always "yes"/"no" in English, even if the answer is in Spanish.)

GLOBAL RULES:
- Answer ONLY using information from the catalog text.
- Do NOT invent prices, services, bundles or conditions that are not in the catalog.
- Be friendly, concise and natural.

PRICE / SERVICE / PLAN QUESTIONS:
- For price questions, use the prices from the catalog.
- If several options are relevant, give a short, clear comparison of the main ones instead of listing everything.

VERY IMPORTANT – COMBINED OPTIONS / BUNDLES:
- If QUESTION_TYPE is "combination_and_price" AND HAS_MULTI_ACCESS_PLAN is "yes":
  - You MUST NOT answer that services/classes cannot be combined.
  - You MUST pick at least one plan/service/pass/bundle from the catalog that clearly:
    - gives access to more than one service or category, OR
    - gives access to "all" or "any" services, OR
    - offers "unlimited" use across multiple services or items.
  - Recommend that option, mention its name, give its main price (for example the main monthly or package price or its most relevant variant), and include its URL if present.
- Only if HAS_MULTI_ACCESS_PLAN is "no" are you allowed to answer that each service is handled/priced separately and list the individual options.

VERY IMPORTANT – "OTHER PLANS" QUESTIONS:
- If QUESTION_TYPE is "other_plans":
  - Assume the client already knows at least one option.
  - Your goal is to present a broader view of the catalog: show different plans/passes/bundles, not just repeat a single one.
  - If the catalog has 3 or more relevant options, list at least 3 distinct options (for example: a trial/pass, a regular membership and a package).
  - It is OK if some were possibly mentioned before, but avoid focusing only on the same plan.

OUTPUT LANGUAGE:
- Always answer in ${idiomaDestino === "en" ? "English" : "Spanish"}.
          `.trim()
          : `
Eres Aamy, asistente de ventas de una plataforma SaaS multinegocio.

Recibes:
- Una sección META con etiquetas de alto nivel.
- La pregunta del cliente.
- Un texto de CATALOGO de este negocio, construido desde las tablas "services" y "service_variants".

ETIQUETAS META:
- QUESTION_TYPE puede ser "combination_and_price", "price_or_plan" o "other_plans".
- HAS_MULTI_ACCESS_PLAN es "yes" si el texto del catálogo contiene claramente al menos un plan/pase/paquete que da acceso a varios servicios/categorías o a "todos"/"cualesquiera" los servicios; en caso contrario es "no". (El valor es siempre "yes"/"no" en inglés, aunque la respuesta sea en español.)

REGLAS GENERALES:
- Responde SOLO usando la información del catálogo.
- NO inventes precios, servicios, paquetes ni condiciones que no aparezcan en el catálogo.
- Usa un tono conversacional, claro y natural.

PREGUNTAS DE PRECIOS / SERVICIOS / PLANES:
- Para preguntas de precios, usa los precios del catálogo.
- Si hay varias opciones relevantes, haz una comparación corta y clara de las principales, en vez de listar todo.

MUY IMPORTANTE – OPCIONES COMBINADAS / PAQUETES:
- Si QUESTION_TYPE es "combination_and_price" Y HAS_MULTI_ACCESS_PLAN es "yes":
  - NO puedes responder que no se pueden combinar servicios/clases.
  - Debes elegir al menos un plan/servicio/pase/paquete del catálogo que claramente:
    - dé acceso a más de un servicio o categoría, O
    - dé acceso a "todos" o "cualesquiera" servicios del negocio, O
    - ofrezca uso "ilimitado" de varios servicios o ítems.
  - Recomienda esa opción, menciona su nombre, da su precio principal (por ejemplo el precio mensual o de paquete más relevante) e incluye su URL si aparece.
- Solo si HAS_MULTI_ACCESS_PLAN es "no" puedes responder que cada servicio se maneja/cobra por separado y listar las opciones individuales.

MUY IMPORTANTE – PREGUNTAS DE "OTROS PLANES":
- Si QUESTION_TYPE es "other_plans":
  - Asume que el cliente ya conoce al menos una opción.
  - Tu objetivo es mostrar una vista más amplia del catálogo: presenta varios planes/pases/paquetes distintos, no repitas solo el mismo plan.
  - Si el catálogo tiene 3 o más opciones relevantes, muestra al menos 3 opciones distintas (por ejemplo: un pase de prueba, una membresía regular y un paquete).
  - Está bien que alguna opción ya se haya mencionado antes, pero evita centrarte otra vez solo en la misma.

IDIOMA DE SALIDA:
- Responde siempre en ${idiomaDestino === "es" ? "español" : "inglés"}.
          `.trim();

      // 6) Mensaje de usuario con META + CATALOGO
      const userMsg =
        idiomaDestino === "en"
          ? `
META:
${metaBlock}

CLIENT QUESTION:
${userInput}

CATALOG:
${catalogText}
          `.trim()
          : `
META:
${metaBlock}

PREGUNTA DEL CLIENTE:
${userInput}

CATALOGO:
${catalogText}
          `.trim();

      const reply = await answerCatalogQuestionLLM({
        idiomaDestino,
        systemMsg,
        userMsg,
      });

      return {
        handled: true,
        reply,
        source: "catalog_llm",
        intent: intentOut || "catalog",
      };
    }
  }

  return { handled: false };
}
