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
  // state context de conversation_state
  last_service_id?: string | null;
  last_service_name?: string | null;
  last_service_at?: number | null;

  pending_price_lookup?: boolean;
  pending_price_at?: number | null;

  // ✅ NUEVO: lista de planes mostrada recientemente (para seleccionar)
  last_plan_list?: Array<{ id: string; name: string; url: string | null }>;
  last_plan_list_at?: number | null;

  // cualquier otra cosa que tengas
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
        | "price_summary_db_empty";
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
  // ✅ PLAN PICK -> SEND SINGLE LINK (NO LIST)
  // ===============================
  {
    const list = Array.isArray(convoCtx?.last_plan_list) ? convoCtx.last_plan_list : [];
    const lastAt = Number(convoCtx?.last_plan_list_at || 0);

    // TTL corto para evitar seleccionar algo viejo (10 min)
    const ttlMs = 10 * 60 * 1000;
    const listFresh = list.length > 0 && lastAt > 0 && Date.now() - lastAt <= ttlMs;

    if (!listFresh) {
      // si está vieja, límpiala (sin cortar flujo)
      if (list.length) {
        // 👇 esto solo limpia estado; deja seguir
        // (si tu caller aplica ctxPatch aunque handled:false, perfecto)
        // si NO, quita este bloque
        return { handled: false, ctxPatch: { last_plan_list: undefined, last_plan_list_at: undefined } };
      }
    } else {
      const idx = parsePickIndex(userInput);

      let picked: { id: string; name: string; url: string | null } | null = null;

      // 1) Selección por número
      if (idx != null) {
        const i = idx - 1;
        if (i >= 0 && i < list.length) picked = list[i];
      }

      // 2) Selección por nombre (si no fue número)
      if (!picked) {
        picked = bestNameMatch(userInput, list);
      }

      if (picked) {
        // si no hay url
        if (!picked.url) {
          return {
            handled: true,
            reply:
              idiomaDestino === "en"
                ? `${picked.name}\nI don’t have a direct link for this option yet. Do you want the price/details?`
                : `${picked.name}\nAún no tengo un link directo para esta opción. ¿Quieres precio/detalles?`,
            source: "service_list_db",
            intent: intentOut || "planes",
            ctxPatch: {
              // limpiar lista para no reusar indefinidamente
              last_plan_list: undefined,
              last_plan_list_at: undefined,

              // set last service para que includes/price funcione luego
              last_service_id: picked.id,
              last_service_name: picked.name,
              last_service_at: Date.now(),
            },
          };
        }

        // ✅ caso normal: manda 1 solo link
        return {
          handled: true,
          reply:
            idiomaDestino === "en"
              ? `${picked.name}\nHere’s the link:\n${picked.url}`
              : `${picked.name}\nAquí tienes el link:\n${picked.url}`,
          source: "service_list_db",
          intent: intentOut || "planes",
          ctxPatch: {
            // ✅ limpiar lista tras elegir para evitar loops
            last_plan_list: undefined,
            last_plan_list_at: undefined,

            // set last service
            last_service_id: picked.id,
            last_service_name: picked.name,
            last_service_at: Date.now(),
          },
        };
      }
    }
  }

  // ✅ PLAN / MEMBERSHIP LIST FASTPATH (DB)
{
  const t = String(userInput || "").toLowerCase();

  const wantsMembershipList =
    /\b(plan(es)?|membres[ií]a(s)?|membership(s)?|monthly)\b/i.test(t);

  if (wantsMembershipList) {
    const r = await resolveServiceList(pool, {
      tenantId,
      limitServices: 20,
      queryText: null,
      tipos: ["plan"], // ✅ IMPORTANTE: tus valores reales son 'plan'
    });

    if (r.ok) {
      const isPackage = (cat: any) => {
        const c = String(cat || "").toLowerCase();
        return c.includes("package"); // Package / Packages
      };

      const memberships = r.items.filter((x) => !isPackage(x.category));
      const packages = r.items.filter((x) => isPackage(x.category));

      const parts: string[] = [];

      if (memberships.length) {
        parts.push(
          renderServiceListReply({
            lang: idiomaDestino === "en" ? "en" : "es",
            items: memberships,
            maxItems: 8,
            includeLinks: false,
            title: idiomaDestino === "en" ? "Membership plans:" : "Planes / Membresías:",
          })
        );
      }

      if (packages.length) {
        parts.push(
          renderServiceListReply({
            lang: idiomaDestino === "en" ? "en" : "es",
            items: packages,
            maxItems: 6,
            includeLinks: false,
            title: idiomaDestino === "en" ? "Packages (optional):" : "Paquetes (opcional):",
          })
        );
      }

      // ✅ ESTE ES EL ORDEN QUE EL CLIENTE VERÁ (para que 1/2/3 funcione)
      const itemsAll = [...memberships, ...packages];

      return {
        handled: true,
        reply: parts.join("\n\n").trim(),
        source: "service_list_db",
        intent: "planes",
        ctxPatch: {
          last_listed_plans_at: Date.now(),

          // ✅ guardar lista para selección (número o nombre)
          last_plan_list: itemsAll.map((x) => ({
            id: x.service_id,
            name: x.name,
            url: x.service_url || null,
          })),
          last_plan_list_at: Date.now(),
        },
      };
    }
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
              ? `✅ ${blk.title}\nIncludes: ${inc}`
              : `✅ ${blk.title}\nIncluye: ${inc}`;

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
            ? `✅ ${r.label}\nIncludes: ${descOut}`
            : `✅ ${r.label}\nIncluye: ${descOut}`;

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
  if (isPriceQuestion(userInput) && askedGenericPrices) {
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
