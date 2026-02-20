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
import { resolveBestLinkForService } from "../links/resolveBestLinkForService";
import { renderInfoGeneralOverview } from "../fastpath/renderInfoGeneralOverview";
import { filterRowsByMeaningfulTokens } from "../services/pricing/priceSummaryTokens";

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
        | "price_summary_db_empty";
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

function normalizeText(s: string) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
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

async function getServiceDetailsText(
  pool: Pool,
  tenantId: string,
  serviceId: string,
  userText: string
): Promise<{ titleSuffix?: string | null; text: string | null }> {
  const t = String(userText || "").trim();

  // 1) intentar variante por texto
  const { rows: vRows } = await pool.query(
    `
    SELECT v.variant_name, v.description
    FROM service_variants v
    JOIN services s ON s.id = v.service_id
    WHERE s.tenant_id = $1
      AND s.id = $2
      AND COALESCE(v.active, true) = true
      AND (
        LOWER($3) LIKE '%' || LOWER(v.variant_name) || '%'
        OR LOWER(v.variant_name) LIKE '%' || LOWER($3) || '%'
      )
    ORDER BY LENGTH(v.variant_name) DESC
    LIMIT 1
    `,
    [tenantId, serviceId, t]
  );

  const v = vRows?.[0];
  const vName = v?.variant_name ? String(v.variant_name).trim() : null;
  const vDesc = v?.description ? String(v.description).trim() : null;

  if (vDesc) return { titleSuffix: vName, text: vDesc };

  // 2) fallback: descripción del servicio
  const { rows: sRows } = await pool.query(
    `
    SELECT description
    FROM services
    WHERE tenant_id = $1 AND id = $2
    LIMIT 1
    `,
    [tenantId, serviceId]
  );

  const sDesc = sRows?.[0]?.description ? String(sRows[0].description).trim() : null;
  return { titleSuffix: null, text: sDesc || null };
}

function isAskingPlansOrPackages(t: string) {
  const s = String(t || "").toLowerCase();
  return (
    /\b(planes?|plan)\b/.test(s) ||
    /\b(paquetes?|paquete)\b/.test(s) ||
    /\b(membres[ií]as?|membresia)\b/.test(s) ||
    /\b(memberships?|membership)\b/.test(s) ||
    /\b(packages?|package)\b/.test(s) ||
    /\b(plans?)\b/.test(s)
  );
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
      const idx = (() => {
        const t = String(userInput || "").trim();
        const m = t.match(/^([1-9])$/); // ✅ SOLO si el user manda "1" (y nada más)
        return m ? Number(m[1]) : null;
      })();

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
        const pickedServiceId = parts[0] || rawPickedId;           // ✅ siempre termina siendo UUID real
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

        const d = await getServiceDetailsText(pool, tenantId, pickedServiceId, userInput).catch(() => null);

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
        const d = await getServiceDetailsText(pool, tenantId, serviceId, userInput).catch(() => null);

        const title = d?.titleSuffix
          ? `${baseName || ""}${baseName ? " — " : ""}${String(d.titleSuffix).trim()}`
          : baseName;

        const infoText = d?.text ? String(d.text).trim() : "";

        const outro =
          idiomaDestino === "en"
            ? "If you need anything else, just let me know 😊"
            : "Si necesitas algo más, déjame saber 😊";

        const reply =
          idiomaDestino === "en"
            ? `${title ? `${title}\n\n` : ""}${infoText ? `${infoText}\n\n` : ""}Here it is 😊\n${pick.url}\n\n${outro}`
            : `${title ? `${title}\n\n` : ""}${infoText ? `${infoText}\n\n` : ""}Aquí lo tienes 😊\n${pick.url}\n\n${outro}`;

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
  // ✅ INFO_CLAVE INCLUDES (si existe info_clave)
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

          let ctxPatch: Partial<FastpathCtx> | undefined;

          try {
            // intenta mapear el bloque de info_clave a un service real del catálogo
            const hit = await resolveServiceIdFromText(pool, tenantId, blk.title);
            if (hit?.id) {
              ctxPatch = {
                last_service_id: hit.id,
                last_service_name: hit.name || blk.title,
                last_service_at: Date.now(),
              };
            } else {
              // fallback: al menos guardar nombre para debugging
              ctxPatch = {
                last_service_name: blk.title,
                last_service_at: Date.now(),
              };
            }
          } catch {
            ctxPatch = {
              last_service_name: blk.title,
              last_service_at: Date.now(),
            };
          }

          return {
            handled: true,
            reply: msg,
            source: "info_clave_includes",
            intent: intentOut || "info",
            ctxPatch,
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

  // =========================================================
  // ✅ INCLUDES FASTPATH (DB catalog)
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

  // ===============================
  // ✅ PLANS / PACKAGES LIST (DB, NO HARDCODE)
  //  - NO mezcla planes + paquetes
  //  - NO números
  //  - CTA humano
  // ===============================
  {
    const askingIncludes = isAskingIncludes(userInput);
    const askingPrice = isPriceQuestion(userInput); // ✅ ya no usamos isGenericPriceQuestion

    if (isPlansOrPackagesQuestion(userInput) && !askingIncludes && !askingPrice) {
      const { rows } = await pool.query(
        `
        SELECT id, name, category, tipo, service_url
        FROM services
        WHERE tenant_id = $1
          AND active = true
        ORDER BY updated_at DESC NULLS LAST, created_at DESC
        LIMIT 50
        `,
        [tenantId]
      );

      const planPkg = (rows || []).filter((r: any) => isPlanPackageType(r.tipo));
      if (!planPkg.length) {
        // no manejamos aquí; deja seguir
      } else {
        const items = planPkg
          .map((r: any) => ({
            service_id: String(r.id),
            name: String(r.name || "").trim(),
            category: r.category ?? null,
            service_url: r.service_url ? String(r.service_url).trim() : null,
          }))
          .filter((x: any) => x.name);

        const packages = items.filter((x: any) => isPackageCategory(x.category));
        const memberships = items.filter((x: any) => isMembershipCategory(x.category));
        const others = items.filter(
          (x: any) => !isPackageCategory(x.category) && !isMembershipCategory(x.category)
        );

        const plans = [...memberships, ...others];

        // ✅ Detectar si el usuario pidió específicamente paquetes
        const tNorm = normalizeText(userInput);
        const wantsPackages =
          /\b(paquete(s)?|package(s)?|bundle(s)?|pack(s)?)\b/i.test(tNorm);

        // ✅ Lista SIN números
        const bulletsNoNum = (arr: any[], max = 10) =>
          arr.slice(0, max).map((x) => `• ${x.name}`).join("\n");

        const ask =
          idiomaDestino === "en"
            ? "Tell me which one you’re interested in and I’ll send you the details 🙂"
            : "Dime cuál te interesa y te envío la información 🙂";

        // ✅ Responder SOLO una lista (planes O paquetes)
        let reply = "";
        let kind: "plan" | "package" = "plan";

        if (wantsPackages) {
          if (!packages.length) {
            reply =
              idiomaDestino === "en"
                ? "We don’t have packages available right now. Would you like to see memberships instead?"
                : "Ahora mismo no tenemos paquetes disponibles. ¿Quieres que te muestre las membresías?";
          } else {
            reply = `${sectionTitle(idiomaDestino, "packages")}\n${bulletsNoNum(packages)}\n\n${ask}`;
            kind = "package";
          }
        } else {
          if (!plans.length) {
            reply =
              idiomaDestino === "en"
                ? "We don’t have memberships available right now. Would you like to see packages instead?"
                : "Ahora mismo no tenemos membresías disponibles. ¿Quieres que te muestre los paquetes?";
          } else {
            reply = `${sectionTitle(idiomaDestino, "plans")}\n${bulletsNoNum(plans)}\n\n${ask}`;
            kind = "plan";
          }
        }

        return {
          handled: true,
          reply,
          source: "service_list_db",
          intent: intentOut || (kind === "package" ? "paquetes" : "planes"),
          ctxPatch: {
            // guardamos ambas listas por si el usuario cambia ("y paquetes?")
            last_plan_list: plans.map((x: any) => ({
              id: x.service_id,
              name: x.name,
              url: x.service_url || null,
            })),
            last_plan_list_at: Date.now(),

            last_package_list: packages.map((x: any) => ({
              id: x.service_id,
              name: x.name,
              url: x.service_url || null,
            })),
            last_package_list_at: Date.now(),

            last_list_kind: kind,
            last_list_kind_at: Date.now(),

            has_packages_available: packages.length > 0,
            has_packages_available_at: Date.now(),
          },
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

  // =========================================================
  // ✅ PRICE SUMMARY (DB) solo si la pregunta es genérica
  //    - rango + ejemplos, NO lista completa
  //    - excluye ADD-ON por categoría
  // =========================================================
  if (
    isPriceQuestion(userInput) &&
    isGenericPriceQuestion(userInput) &&
    !isPlansOrPackagesQuestion(userInput)
  ) {
    const { rows } = await pool.query(
      `
      WITH base AS (
        SELECT
          s.id AS service_id,
          s.name AS service_name,
          s.price_base::numeric AS price
        FROM services s
        WHERE
          s.tenant_id = $1
          AND s.active = true
          AND s.price_base IS NOT NULL
          AND (
            s.category IS NULL
            OR regexp_replace(lower(s.category), '[^a-z]', '', 'g') <> 'addon'
          )

        UNION ALL

        SELECT
          v.service_id,
          s.name AS service_name,
          v.price::numeric AS price
        FROM service_variants v
        JOIN services s ON s.id = v.service_id
        WHERE
          s.tenant_id = $1
          AND s.active = true
          AND v.active = true
          AND v.price IS NOT NULL
          AND (
            s.category IS NULL
            OR regexp_replace(lower(s.category), '[^a-z]', '', 'g') <> 'addon'
          )
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

    const overallMin =
      rows?.[0]?.overall_min != null ? Number(rows[0].overall_min) : null;
    const overallMax =
      rows?.[0]?.overall_max != null ? Number(rows[0].overall_max) : null;

    // Si no hay precios válidos, deja que el pipeline normal responda
    if (overallMin == null || overallMax == null) {
      return { handled: false };
    }

    const simpleRows = rows.map((r: any) => ({
      service_name: String(r.service_name || "").trim(),
      min_price: Number(r.min_price),
      max_price: Number(r.max_price),
    }));

    // Texto base por si algún canal lo quiere usar directo.
    const msg = renderGenericPriceSummaryReply({
      lang: idiomaDestino,
      rows: simpleRows,
    });

    return {
      handled: true,
      reply: msg,
      source: "price_summary_db",
      intent: intentOut || "precio",
      fastpathHint: {
        type: "price_summary",
        payload: {
          lang: idiomaDestino,
          rows: simpleRows,
        },
      },
    };
  }

  return { handled: false };
}
