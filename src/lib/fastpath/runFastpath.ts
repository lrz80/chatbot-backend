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
} from "../infoclave/resolveIncludes";

// DB catalog includes
import { resolveServiceInfo } from "../services/resolveServiceInfo";

// Pricing
import { getPriceInfoForService } from "../services/pricing/getFromPriceForService";
import { resolveServiceIdFromText } from "../services/pricing/resolveServiceIdFromText";
import { renderPriceReply } from "../services/pricing/renderPriceReply";
import { isGenericPriceQuestion } from "../services/pricing/isGenericPriceQuestion";
import { renderGenericPriceSummaryReply } from "../services/pricing/renderGenericPriceSummaryReply";
import { resolveServiceList } from "../services/resolveServiceList";
import { renderServiceListReply } from "../services/renderServiceListReply";

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

  // ✅ elección desde pregunta del asistente (LLM) tipo "A, B o ambas"
  last_choice_options?: Array<{ key: string; label: string; payload?: any }>;
  last_choice_at?: number | null;
  last_choice_kind?: string | null;

  chosen_choice_key?: string | null;
  chosen_choice_label?: string | null;
  chosen_choice_at?: number | null;

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
        | "price_summary_db_empty"
        | "choice_pick";
      intent: string | null;
      ctxPatch?: Partial<FastpathCtx>;
      awaitingEffect?: FastpathAwaitingEffect;
    }
  | {
      handled: false;
      ctxPatch?: Partial<FastpathCtx>;
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

function normalizeText(s: string) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function parsePickIndex(text: string): number | null {
  // acepta "1", "1)", "1.", "opcion 1", "la 2", etc.
  const t = normalizeText(text);
  const m = t.match(/\b(\d{1,2})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
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

function normalizeTokensForLike(q: string) {
  return q
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .slice(0, 4);
}

// Detector genérico (no industria)
function isPriceQuestion(text: string) {
  const t = String(text || "").toLowerCase();
  return /\b(precio|precios|cu[aá]nto\s+cuesta|cu[aá]nto\s+vale|costo|cost|price|how\s+much|starts?\s+at|from|desde)\b/i.test(
    t
  );
}

// “planes/membresía” también es genérico (no negocio específico)
function isMembershipLikeQuestion(text: string) {
  const t = String(text || "").toLowerCase();
  return /\b(plan(es)?|mensual(es)?|membres[ií]a(s)?|monthly|membership)\b/i.test(t);
}

function isFreeOfferQuestion(text: string) {
  const t = String(text || "").toLowerCase();

  // Multi-negocio: "gratis/free" + señal de "trial/prueba/demo"
  // No requiere "clase/class" (pero lo acepta si viene).
  const hasFree = /\b(gratis|free)\b/i.test(t);
  const hasTrialSignal = /\b(prueba|trial|demo|promocion|promoción|clase|class)\b/i.test(t);

  return hasFree && hasTrialSignal;
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

function wrapHumanList(args: {
  lang: Lang;
  title: string;
  listText: string;
  kind: "plans" | "packages";
  secondaryAvailable?: boolean;
}) {
  const { lang, title, listText, kind, secondaryAvailable } = args;

  if (lang === "en") {
    const intro = "Sure! Here are some options 😊";
    const ask =
      kind === "plans"
        ? "Let me know what you're looking for and I’ll recommend the best fit 😊"
        : "Let me know what you need and I’ll help you choose 😊";
    const secondary = secondaryAvailable ? "\nIf you prefer, we also have packages." : "";
    return `${intro}\n\n${title}\n${listText}\n\n${ask}${secondary}`;
  }

  // ES
  const intro = "¡Claro! Aquí tienes algunas opciones 😊";
  const ask =
    kind === "plans"
      ? "Cuéntame qué estás buscando y te recomiendo la mejor opción 😊"
      : "Cuéntame qué necesitas y te ayudo a elegir 😊";
  const secondary = secondaryAvailable ? "\nSi prefieres, también tenemos paquetes." : "";
  return `${intro}\n\n${title}\n${listText}\n\n${ask}${secondary}`;
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

  // Fastpath solo aplica si NO estás en booking
  if (inBooking) return { handled: false };

  const intentOut = (detectedIntent || "").trim() || null;

  // ===============================
// ✅ PICK FROM LAST CHOICE (LLM) -> RESOLVE "ambas/both/1/2/name"
// ===============================
{
  const ttlMs = 10 * 60 * 1000;

  const opts = Array.isArray(convoCtx?.last_choice_options) ? convoCtx.last_choice_options : [];
  const at = Number(convoCtx?.last_choice_at || 0);
  const fresh = opts.length > 0 && at > 0 && Date.now() - at <= ttlMs;

  if (fresh) {
    const idx = parsePickIndex(userInput);

    const normalize = (s: string) => normalizeText(String(s || ""));

    const isBothText = (txt: string) => {
      const t = normalize(txt);
      return (
        t === "ambas" ||
        t === "ambos" ||
        t === "los dos" ||
        t === "las dos" ||
        t === "both" ||
        t === "both of them"
      );
    };

    const tryPick = () => {
      // 1) by index
      if (idx != null) {
        const i = idx - 1;
        if (i >= 0 && i < opts.length) return opts[i];
      }

      // 2) by "both/ambas" generic
      if (isBothText(userInput)) {
        const bothOpt = opts.find((o) => normalize(o.label) === "ambas" || normalize(o.label) === "both");
        if (bothOpt) return bothOpt;
        const allKey = opts.find((o) => String(o.key).toUpperCase() === "ALL");
        if (allKey) return allKey;
      }

      // 3) by label inclusion (no negocio)
      const u = normalize(userInput);
      if (!u) return null;

      const hits = opts.filter((o) => {
        const l = normalize(o.label);
        return l.includes(u) || u.includes(l);
      });

      if (hits.length === 1) return hits[0];
      if (hits.length > 1) {
        // elige label más largo (más específico)
        return hits.sort((a, b) => normalize(b.label).length - normalize(a.label).length)[0];
      }

      return null;
    };

    const picked = tryPick();

    if (picked) {
      const pickedKey = String(picked.key || "").trim() || null;
      const pickedLabel = String(picked.label || "").trim() || null;

      const ctxPatch: Partial<FastpathCtx> = {
        chosen_choice_key: pickedKey,
        chosen_choice_label: pickedLabel,
        chosen_choice_at: Date.now(),

        // limpiar elección pendiente (evita loops)
        last_choice_options: undefined,
        last_choice_at: undefined,
        last_choice_kind: undefined,
      };

      const reply =
        idiomaDestino === "en"
          ? `Perfect 😊 Got it: ${pickedLabel}. What would you like to know?`
          : `Perfecto 😊 Listo: ${pickedLabel}. ¿Qué te gustaría saber?`;

      return {
        handled: true,
        reply,
        source: "choice_pick",
        intent: intentOut || "seleccion",
        ctxPatch,
      };
    }
  }
}

  // ===============================
// ✅ PICK FROM LAST LIST -> SEND SINGLE LINK
// ===============================
{
  const ttlMs = 10 * 60 * 1000;

  const planList = Array.isArray(convoCtx?.last_plan_list) ? convoCtx.last_plan_list : [];
  const planAt = Number(convoCtx?.last_plan_list_at || 0);
  const planFresh = planList.length > 0 && planAt > 0 && Date.now() - planAt <= ttlMs;

  const pkgList = Array.isArray(convoCtx?.last_package_list) ? convoCtx.last_package_list : [];
  const pkgAt = Number(convoCtx?.last_package_list_at || 0);
  const pkgFresh = pkgList.length > 0 && pkgAt > 0 && Date.now() - pkgAt <= ttlMs;

  const kind = (convoCtx?.last_list_kind as any) || null;
  const kindAt = Number(convoCtx?.last_list_kind_at || 0);
  const kindFresh = kind && kindAt > 0 && Date.now() - kindAt <= ttlMs;

  if (planFresh || pkgFresh) {
    const idx = parsePickIndex(userInput);

    const tryPick = (list: Array<{ id: string; name: string; url: string | null }>) => {
      let picked: { id: string; name: string; url: string | null } | null = null;

      if (idx != null) {
        const i = idx - 1;
        if (i >= 0 && i < list.length) picked = list[i];
      }
      if (!picked) picked = bestNameMatch(userInput, list);

      return picked;
    };

    // ✅ prioridad por “último tipo listado” si está fresco
    let picked: { id: string; name: string; url: string | null } | null = null;

    if (kindFresh && kind === "package") {
      if (pkgFresh) picked = tryPick(pkgList);
      if (!picked && planFresh) picked = tryPick(planList);
    } else {
      // default: plan primero
      if (planFresh) picked = tryPick(planList);
      if (!picked && pkgFresh) picked = tryPick(pkgList);
    }

    if (picked) {
      const basePatch: Partial<FastpathCtx> = {
        // limpiar listas tras elegir (evita loops)
        last_plan_list: undefined,
        last_plan_list_at: undefined,
        last_package_list: undefined,
        last_package_list_at: undefined,
        last_list_kind: undefined,
        last_list_kind_at: undefined,

        // set last_service para price/includes
        last_service_id: picked.id,
        last_service_name: picked.name,
        last_service_at: Date.now(),
      };

      // manda link SOLO si existe
      const reply = picked.url ? `${picked.name}\n${picked.url}` : `${picked.name}`;

      return {
        handled: true,
        reply,
        source: "service_list_db",
        intent: intentOut || "seleccion",
        ctxPatch: basePatch,
      };
    }
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

  // =========================================================
  // 1) INFO_CLAVE INCLUDES (si existe info_clave)
  // =========================================================
  {
    const info = String(infoClave || "").trim();

    if (info && isAskingIncludes(userInput)) {
      const blk = findServiceBlock(info, userInput);

      if (blk) {
        const inc = extractIncludesLine(blk.lines);

        if (inc) {
          const msg =
            idiomaDestino === "en"
              ? `${blk.title}\nIncludes: ${inc}`
              : `${blk.title}\nIncluye: ${inc}`;

          return {
            handled: true,
            reply: msg,
            source: "info_clave_includes",
            intent: intentOut || "info",
          };
        }

        const msg =
          idiomaDestino === "en"
            ? `I found "${blk.title}", but the service details are not loaded yet.`
            : `Encontré "${blk.title}", pero aún no tengo cargado qué incluye.`;

        return {
          handled: true,
          reply: msg,
          source: "info_clave_missing_includes",
          intent: intentOut || "info",
        };
      }

      // Si no matcheó, NO cortamos aquí (dejamos que DB intente resolver)
    }
  }

  // ===============================
// ✅ PACKAGES LIST (DB) - ONLY PACKAGES
// ===============================
{
  const t = String(userInput || "").toLowerCase();

  const wantsPackages =
    /\b(paquete(s)?|packages?|bundle(s)?|pack(s)?)\b/i.test(t);

  const askingIncludes = isAskingIncludes(userInput);
  const askingPrice = isPriceQuestion(userInput) || isGenericPriceQuestion(userInput);

  if (wantsPackages && !askingIncludes && !askingPrice) {
    const r = await resolveServiceList(pool, {
      tenantId,
      limitServices: 20,
      queryText: null,
      tipos: ["plan"],
    });

    if (r.ok) {
      const isPackage = (cat: any) => String(cat || "").toLowerCase().includes("package");
      const packages = r.items.filter((x) => isPackage(x.category));

      if (packages.length) {
        const baseList = renderServiceListReply({
          lang: idiomaDestino === "en" ? "en" : "es",
          items: packages,
          maxItems: 8,
          includeLinks: false,
          title: idiomaDestino === "en" ? "Packages:" : "Paquetes:",
          style: "bullets",
          askPick: false,
        });

        // ✅ wrap humano (sin hardcode por tenant)
        const reply =
          idiomaDestino === "en"
            ? `Sure! Here are the available packages 😊\n\n${baseList}\n\nWhich one are you interested in— or tell me what you need and I’ll recommend the best fit.`
            : `¡Claro! Estos son los paquetes disponibles 😊\n\n${baseList}\n\n¿Cuál te interesa— o cuéntame qué necesitas y te recomiendo el mejor?`;

        return {
          handled: true,
          reply,
          source: "service_list_db",
          intent: "paquetes",
          ctxPatch: {
            last_package_list: packages.map((x) => ({
              id: x.service_id,
              name: x.name,
              url: x.service_url || null,
            })),
            last_package_list_at: Date.now(),
            last_list_kind: "package",
            last_list_kind_at: Date.now(),
          },
        };
      }
    }
  }
}

 // ===============================
// ✅ PLANS LIST (DB) - ONLY PLANS
// ===============================
{
  const t = String(userInput || "").toLowerCase();

  const wantsPlans =
    /\b(plan(es)?|membres[ií]a(s)?|membership(s)?|monthly)\b/i.test(t);

  const askingIncludes = isAskingIncludes(userInput);
  const askingPrice = isPriceQuestion(userInput) || isGenericPriceQuestion(userInput);

  if (wantsPlans && !askingIncludes && !askingPrice) {
    const r = await resolveServiceList(pool, {
      tenantId,
      limitServices: 20,
      queryText: null,
      tipos: ["plan"], // tus valores reales
    });

    if (r.ok) {
      const isPackage = (cat: any) => String(cat || "").toLowerCase().includes("package");

      const plans = r.items.filter((x) => !isPackage(x.category));
      const packages = r.items.filter((x) => isPackage(x.category));

      if (plans.length) {
        const baseList = renderServiceListReply({
          lang: idiomaDestino === "en" ? "en" : "es",
          items: plans,
          maxItems: 8,
          includeLinks: false,
          title: undefined,
          style: "bullets",
          askPick: false, // ✅ clave: quita la pregunta robótica interna
        });

        const reply = wrapHumanList({
          lang: idiomaDestino,
          title: idiomaDestino === "en"
            ? "Plans / Memberships:"
            : "Planes / Membresías:",
          listText: baseList,
          kind: "plans",
          secondaryAvailable: packages.length > 0,
        });

        return {
          handled: true,
          reply,
          source: "service_list_db",
          intent: "planes",
          ctxPatch: {
            last_plan_list: plans.map((x) => ({ id: x.service_id, name: x.name, url: x.service_url || null })),
            last_plan_list_at: Date.now(),
            last_list_kind: "plan",
            last_list_kind_at: Date.now(),
            has_packages_available: packages.length > 0,
            has_packages_available_at: Date.now(),
            last_package_list: packages.map((x) => ({ id: x.service_id, name: x.name, url: x.service_url || null })),
            last_package_list_at: Date.now(),
          },
        };
      }
    }
  }
}

  // =========================================================
  // 2) INCLUDES FASTPATH (DB catalog)
  // =========================================================
  if (isAskingIncludes(userInput)) {
    const r = await resolveServiceInfo({
      tenantId,
      query: userInput,
      need: "includes",
      limit: maxDisambiguationOptions,
    });

    if (r.ok) {
      const ctxPatch: Partial<FastpathCtx> = {
        last_service_id: r.service_id,
        last_service_name: r.label,
        last_service_at: Date.now(),
      };

      if (r.description && String(r.description).trim()) {
        let descOut = String(r.description).trim();

        // Traducción ES<->EN (sin hardcode por negocio)
        try {
          const idOut = await detectarIdioma(descOut);
          if ((idOut === "es" || idOut === "en") && idOut !== idiomaDestino) {
            descOut = await traducirMensaje(descOut, idiomaDestino);
          }
        } catch {
          // no-op
        }

        const msg =
          idiomaDestino === "en"
            ? `${r.label}\nIncludes: ${descOut}`
            : `${r.label}\nIncluye: ${descOut}`;

        return {
          handled: true,
          reply: msg,
          source: "includes_fastpath_db",
          intent: intentOut || "info",
          ctxPatch,
        };
      }

      const msg =
        idiomaDestino === "en"
          ? `I found "${r.label}", but I don’t have the service details loaded yet.`
          : `Encontré "${r.label}", pero aún no tengo cargado qué incluye.`;

      return {
        handled: true,
        reply: msg,
        source: "includes_fastpath_db_missing",
        intent: intentOut || "info",
        ctxPatch,
      };
    }

    if (r.reason === "ambiguous" && r.options?.length) {
      const opts = r.options
        .slice(0, maxDisambiguationOptions)
        .map((o) => `• ${o.label}`)
        .join("\n");

      const ask =
        idiomaDestino === "en"
          ? `Which one do you mean?\n${opts}`
          : `¿Cuál de estos es?\n${opts}`;

      return {
        handled: true,
        reply: ask,
        source: "includes_fastpath_db_ambiguous",
        intent: intentOut || "info",
      };
    }
  }

  // =========================================================
  // 3) PRICE FASTPATH (DB)
  //    - usa contexto si existe (TTL)
  //    - si no, resuelve por texto
  //    - si ambiguo, desambigua con candidates
  // =========================================================
  const askedGenericPrices = isGenericPriceQuestion(userInput);
  const wantsPrice = isPriceQuestion(userInput) || isMembershipLikeQuestion(userInput);

  if (wantsPrice) {
    let ctxPatch: Partial<FastpathCtx> | undefined;

    // A) contexto de último servicio (con TTL)
    let serviceId: string | null = convoCtx?.last_service_id || null;
    let serviceName: string | null = convoCtx?.last_service_name || null;
    const lastAt = Number(convoCtx?.last_service_at || 0);

    if (serviceId && lastAt && Number.isFinite(lastAt)) {
      const age = Date.now() - lastAt;
      if (age > lastServiceTtlMs) {
        serviceId = null;
        serviceName = null;
        ctxPatch = {
          last_service_id: null,
          last_service_name: null,
          last_service_at: null,
        };
      }
    }

    // B) intenta resolver serviceId por texto
    if (!serviceId) {
      const hit = await resolveServiceIdFromText(pool, tenantId, userInput);
      if (hit?.id) {
        serviceId = hit.id;
        serviceName = hit.name;
        ctxPatch = {
          ...(ctxPatch || {}),
          last_service_id: serviceId,
          last_service_name: serviceName,
          last_service_at: Date.now(),
        };
      }
    }

    // C) desambiguación simple por LIKE (sin depender de industria)
    if (!serviceId) {
      const tokens = normalizeTokensForLike(userInput);

      if (tokens.length) {
        const likeParts = tokens.map((_, i) => `lower(s.name) LIKE $${i + 2}`);
        const params: any[] = [tenantId, ...tokens.map((t) => `%${t}%`)];

        const { rows } = await pool.query(
          `
          SELECT s.id, s.name
          FROM services s
          WHERE s.tenant_id = $1
            AND s.active = true
            AND (${likeParts.join(" OR ")})
          ORDER BY s.updated_at DESC NULLS LAST, s.created_at DESC
          LIMIT ${maxDisambiguationOptions}
          `,
          params
        );

        if (rows?.length) {
          const opts = rows.map((r: any) => `• ${r.name}`).join("\n");
          const ask =
            idiomaDestino === "en"
              ? `Which of these options do you mean?\n${opts}`
              : `¿Cuál de estas opciones te interesa?\n${opts}`;

          return {
            handled: true,
            reply: ask,
            source: "price_disambiguation_db",
            intent: intentOut || "precio",
            ctxPatch,
          };
        }
      }
    }

    // D) si ya tenemos serviceId => traer precio y responder
    if (serviceId) {
      const pi = await getPriceInfoForService(pool, tenantId, serviceId);

      if (!pi.ok) {
        // no “error”, solo pedir especificación
        ctxPatch = {
          ...(ctxPatch || {}),
          pending_price_lookup: true,
          pending_price_at: Date.now(),
        };

        const msg =
          idiomaDestino === "en"
            ? "To give you an exact price, which specific service/plan do you mean?"
            : "Para darte el precio exacto, ¿cuál servicio/plan específico te interesa?";

        return {
          handled: true,
          reply: msg,
          source: "price_missing_db",
          intent: intentOut || "precio",
          ctxPatch,
        };
      }

      const msg = renderPriceReply({
        lang: idiomaDestino === "en" ? "en" : "es",
        mode: pi.mode,
        amount: pi.amount,
        currency: (pi.currency || "USD").toUpperCase(),
        serviceName: serviceName || null,
        options: pi.mode === "from" ? (pi.options || []) : undefined,
        optionsCount: pi.mode === "from" ? (pi.optionsCount as any) : undefined,
      });

      // Si es precio fijo, puedes querer “awaiting yes/no” para confirmar algo
      // (NO side effect aquí: devolvemos efecto declarativo)
      const awaitingEffect: FastpathAwaitingEffect =
        pi.mode === "fixed"
          ? {
              type: "set_awaiting_yes_no",
              ttlSeconds: 600,
              payload: { kind: "confirm_booking", source: "price_fastpath_db", serviceId },
            }
          : { type: "none" };

      return {
        handled: true,
        reply: msg,
        source: "price_fastpath_db",
        intent: intentOut || "precio",
        ctxPatch,
        awaitingEffect,
      };
    }
  }

  // =========================================================
  // 4) PRICE SUMMARY (DB) solo si la pregunta es genérica
  //    - rango + ejemplos, NO lista completa
  // =========================================================
  if (isPriceQuestion(userInput) && isGenericPriceQuestion(userInput)) {
    const { rows } = await pool.query(
      `
      WITH base AS (
        SELECT s.id AS service_id, s.name AS service_name, s.price_base::numeric AS price
        FROM services s
        WHERE s.tenant_id = $1 AND s.active = true AND s.price_base IS NOT NULL

        UNION ALL

        SELECT v.service_id, s.name AS service_name, v.price::numeric AS price
        FROM service_variants v
        JOIN services s ON s.id = v.service_id
        WHERE s.tenant_id = $1 AND s.active = true AND v.active = true AND v.price IS NOT NULL
      ),
      agg AS (
        SELECT service_id, service_name, MIN(price) AS min_price, MAX(price) AS max_price
        FROM base
        GROUP BY service_id, service_name
      ),
      bounds AS (
        SELECT
          (SELECT MIN(min_price) FROM agg) AS overall_min,
          (SELECT MAX(max_price) FROM agg) AS overall_max
      ),
      cheap AS (
        SELECT * FROM agg ORDER BY min_price ASC LIMIT 3
      ),
      expensive AS (
        SELECT * FROM agg ORDER BY max_price DESC LIMIT 2
      ),
      picked AS (
        SELECT * FROM cheap
        UNION
        SELECT * FROM expensive
      )
      SELECT
        b.overall_min,
        b.overall_max,
        p.service_name,
        p.min_price,
        p.max_price
      FROM picked p
      CROSS JOIN bounds b
      ORDER BY p.min_price ASC;
      `,
      [tenantId]
    );

    const overallMin = rows?.[0]?.overall_min != null ? Number(rows[0].overall_min) : null;
    const overallMax = rows?.[0]?.overall_max != null ? Number(rows[0].overall_max) : null;

    if (overallMin == null || overallMax == null) {
      const msg =
        idiomaDestino === "en"
          ? "Which specific service are you interested in?"
          : "¿Qué servicio específico te interesa?";

      return {
        handled: true,
        reply: msg,
        source: "price_summary_db_empty",
        intent: intentOut || "precio",
      };
    }

    const msg = renderGenericPriceSummaryReply({
      lang: idiomaDestino,
      rows: rows.map((r: any) => ({
        service_name: r.service_name,
        min_price: r.min_price,
        max_price: r.max_price,
      })),
    });

    return {
      handled: true,
      reply: msg,
      source: "price_summary_db",
      intent: intentOut || "precio",
    };
  }

  return { handled: false };
}
