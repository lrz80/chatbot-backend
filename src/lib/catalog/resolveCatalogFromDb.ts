// backend/src/lib/catalog/resolveCatalogFromDb.ts
import type { Pool } from "pg";
import type { CatalogNeed, CatalogResult, Lang } from "./types";
import { userMentionsVariantHint } from "./variantHints";
import { inferSizeTokenFromText, inferWeightLbsFromText } from "./normalizeSize";

type SizeToken = "small" | "medium" | "large" | "xl";

function looksLikeSizeTierName(name: string): boolean {
  const s = String(name || "").toLowerCase();
  // ES/EN tamaños + patrones de peso típicos de grooming
  return (
    /\b(xs|x-small|small|medium|large|xl|x-large|extra\s*large)\b/.test(s) ||
    /\b(peque(n|ñ)o|mediano|grande)\b/.test(s) ||
    /\b(\d+\s*(lb|lbs|pounds|kg))\b/.test(s) ||
    /\b(0-?\d+\s*lbs|\d+\+?\s*lbs|\d+\s*to\s*\d+\s*lbs)\b/.test(s)
  );
}

/**
 * Determina si las variantes SON "tamaños" (grooming) vs "opciones/planes" (Synergy).
 * Si NO son tamaños, NO debemos preguntar "small/medium/large".
 */
function variantsAreSizeBased(variants: any[]): boolean {
  if (!Array.isArray(variants) || variants.length === 0) return false;

  // Si ya tienes columnas en DB (size_token / min_weight / max_weight) y vienen pobladas
  const hasStructured =
    variants.some((v) => String(v?.size_token || "").trim()) ||
    variants.some((v) => v?.min_weight_lbs != null || v?.max_weight_lbs != null);

  if (hasStructured) return true;

  // Si por nombre parecen tallas/pesos
  return variants.some((v) => looksLikeSizeTierName(String(v?.variant_name || "")));
}

function moneyOrNull(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toCurrency(v: any): string {
  const s = String(v || "").trim().toUpperCase();
  return s || "USD";
}

// Para listas: límite para WhatsApp / no spamear
const DEFAULT_LIST_LIMIT = 6;

// ✅ Precio de variante: soporta price_base (tu schema) o price (compat)
function variantPrice(v: any): number | null {
  return moneyOrNull(v?.price_base ?? v?.price ?? null);
}

function servicePrice(s: any): number | null {
  return moneyOrNull(s?.price_base ?? s?.price ?? null);
}

function normalizeLabelOnly(s: string) {
  let t = String(s || "").trim();
  t = t.replace(/\s*[:\-–]\s*\$.*$/i, "").trim();
  t = t.replace(/\s*[:\-–]\s*usd.*$/i, "").trim();
  t = t.replace(/\s*\$?\d+(\.\d{1,2})?\s*(usd|mxn|eur)?\b.*$/i, "").trim();
  t = t.replace(/\s*\(([^)]{25,})\)\s*$/, "").trim();
  return t;
}

function isProbablyPriceLine(s: string) {
  const t = (s || "").toLowerCase();
  return (
    /\$|usd|mxn|eur|por mes|\/mo|monthly|mensual|price|precio|costo|cost/.test(t) ||
    /\b\d{1,4}\.\d{2}\b/.test(t)
  );
}

async function fetchPlanNames(pool: Pool, tenantId: string, limit: number) {
  const { rows } = await pool.query(
    `
    SELECT id, name
    FROM services
    WHERE tenant_id = $1
      AND active = true
      AND COALESCE(tipo,'service') = 'plan'
    ORDER BY COALESCE(sort_order, 9999) ASC, name ASC
    LIMIT $2
    `,
    [tenantId, limit]
  );

  const seen = new Set<string>();
  const out: Array<{ service_id: string; label: string }> = [];

  for (const r of rows) {
    const raw = String(r?.name || "").trim();
    if (!raw) continue;

    const label = normalizeLabelOnly(raw);
    if (!label || isProbablyPriceLine(label)) continue;

    const k = label.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);

    out.push({ service_id: String(r.id), label });
  }

  return out;
}

export async function resolveCatalogFromDb(args: {
  pool: Pool;
  tenantId: string;
  userInput: string;
  need: CatalogNeed;
  idioma: Lang;
  lastRef?: any; // ctx?.last_service_ref
  limit?: number; // ✅ para listas y opciones
}): Promise<CatalogResult> {
  const { pool, tenantId, userInput, need, idioma, lastRef } = args;
  const q = String(userInput || "").trim();
  const limit = Math.max(1, Math.min(12, Number(args.limit ?? DEFAULT_LIST_LIMIT)));

  // Helpers de respuesta
  const askWhichService =
    idioma === "en"
      ? "Which service exactly? Tell me the name."
      : "¿Cuál servicio exactamente? Dime el nombre.";

  const askWhichPlanOrService =
    idioma === "en"
      ? "Which plan/service do you mean? Tell me the name."
      : "¿Qué plan o servicio exactamente? Dime el nombre.";

  const askWhichPlan =
    idioma === "en" ? "Which plan are you interested in?" : "¿Cuál plan te interesa?";

  const isPriceNeed = need === "price" || need === "any";
  const isListNeed = need === "list";
  const isInfoNeed = need === "includes" || need === "duration" || need === "link";

  if (!q) {
    // ✅ Si piden precios sin texto, manda planes (para escoger)
    if (isPriceNeed) {
      const plans = await fetchPlanNames(pool, tenantId, Math.min(7, limit));
      if (plans.length) {
        const bullets = plans.map((p) => `- ${p.label}`).join("\n");
        return {
          hit: true,
          status: "needs_clarification",
          need,
          ask:
            idioma === "en"
              ? `Here are some plan options:\n${bullets}\n\n${askWhichPlan}`
              : `Estos son algunos planes:\n${bullets}\n\n${askWhichPlan}`,
          options: plans,
        };
      }
    }
    return { hit: true, status: "no_match", need, ask: askWhichPlanOrService };
  }

  // =========================
  // 0) Hint de variante (tamaño/peso) con lastRef fresco
  //    ✅ OJO: esto aplica SOLO cuando NO es plan
  // =========================
  const lastRefFresh = (() => {
    const saved = String(lastRef?.saved_at || "").trim();
    if (!saved) return false;
    const ts = Date.parse(saved);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < 1000 * 60 * 20; // 20 min
  })();

  const sizeToken = inferSizeTokenFromText(q) as SizeToken | null;
  const weightLbs = inferWeightLbsFromText(q);
  const mentionsVariant = userMentionsVariantHint(q) || !!sizeToken || !!weightLbs;

  if (lastRefFresh && lastRef?.service_id && mentionsVariant) {
    const serviceId = String(lastRef.service_id);

    // primero: saber si ese service es plan (si es plan, NO size-based)
    const { rows: srows0 } = await pool.query(
      `
      SELECT id, name, description, duration_min, price_base, service_url, COALESCE(tipo,'service') AS tipo
      FROM services
      WHERE tenant_id = $1 AND id = $2 AND active = TRUE
      LIMIT 1
      `,
      [tenantId, serviceId]
    );

    const s0 = srows0[0];
    const isPlan0 = String(s0?.tipo || "").toLowerCase() === "plan";

    const { rows: variants } = await pool.query(
      `
      SELECT v.id, v.variant_name, v.description,
             COALESCE(v.price_base, v.price) AS price_base,
             v.currency, v.duration_min, v.variant_url,
             v.size_token, v.min_weight_lbs, v.max_weight_lbs
      FROM service_variants v
      WHERE v.service_id = $1 AND v.active = TRUE
      ORDER BY
        CASE v.size_token
          WHEN 'small' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'large' THEN 3
          WHEN 'xl' THEN 4
          ELSE 99
        END,
        v.variant_name ASC
      `,
      [serviceId]
    );

    let picked: any = null;

    // ✅ SOLO grooming: match por peso/size_token
    if (!isPlan0) {
      if (weightLbs != null) {
        picked = variants.find((v: any) => {
          const max = v.max_weight_lbs != null ? Number(v.max_weight_lbs) : null;
          const min = v.min_weight_lbs != null ? Number(v.min_weight_lbs) : null;
          if (max != null && weightLbs > max) return false;
          if (min != null && weightLbs < min) return false;
          return true;
        });
      }

      if (!picked && sizeToken) {
        picked = variants.find((v: any) => String(v.size_token || "") === sizeToken);
      }
    }

    // fallback (plan o no-plan)
    if (!picked) picked = variants[0];

    if (s0 && picked) {
      const facts = {
        kind: "variant" as const,
        label: `${s0.name} - ${picked.variant_name}`,
        service_id: String(s0.id),
        variant_id: String(picked.id),
        price: variantPrice(picked) ?? servicePrice(s0),
        currency: toCurrency(picked.currency || "USD"),
        duration_min: moneyOrNull(picked.duration_min) ?? moneyOrNull(s0.duration_min),
        description: picked.description
          ? String(picked.description)
          : s0.description
          ? String(s0.description)
          : null,
        url: picked.variant_url || s0.service_url || null,
      };

      return {
        hit: true,
        status: "resolved",
        need,
        facts,
        ctxPatch: {
          last_service_ref: {
            kind: "variant",
            label: facts.label,
            service_id: facts.service_id,
            variant_id: facts.variant_id,
            saved_at: new Date().toISOString(),
          },
        },
      };
    }
  }

  // =========================
  // 1) BÚSQUEDA por similarity (cuando el usuario menciona algo)
  // =========================
  const { rows: services } = await pool.query(
    `
    SELECT s.*,
      GREATEST(similarity(s.name, $2), similarity(COALESCE(s.description,''), $2)) AS score
    FROM services s
    WHERE s.tenant_id = $1
      AND s.active = TRUE
      AND (s.name % $2 OR COALESCE(s.description,'') % $2)
    ORDER BY score DESC, s.name ASC
    LIMIT 5
    `,
    [tenantId, q]
  );

  // =========================
  // 1B) Si no hay match:
  // ✅ Si piden PRECIOS sin especificar -> mandar RESUMEN DE PLANES para elegir
  // =========================
  if (!services.length) {
    if (isPriceNeed) {
      const plans = await fetchPlanNames(pool, tenantId, Math.min(7, limit));
      if (plans.length) {
        const bullets = plans.map((p) => `- ${p.label}`).join("\n");
        return {
          hit: true,
          status: "needs_clarification",
          need,
          ask:
            idioma === "en"
              ? `Here are some plan options:\n${bullets}\n\n${askWhichPlan}`
              : `Estos son algunos planes:\n${bullets}\n\n${askWhichPlan}`,
          options: plans,
        };
      }
    }

    // Si era list -> lista global (planes primero), pero SIN spamear
    if (isListNeed) {
      const { rows: top } = await pool.query(
        `
        SELECT s.id, s.name, s.category, COALESCE(s.tipo,'service') AS tipo,
               s.price_base, s.duration_min, s.service_url,
               (SELECT MIN(COALESCE(v.price_base, v.price)) FROM service_variants v WHERE v.service_id = s.id AND v.active = TRUE) AS min_variant_price,
               (SELECT COUNT(*) FROM service_variants v WHERE v.service_id = s.id AND v.active = TRUE) AS variants_count
        FROM services s
        WHERE s.tenant_id = $1 AND s.active = TRUE
        ORDER BY
          CASE WHEN COALESCE(s.tipo,'service') = 'plan' THEN 0 ELSE 1 END,
          COALESCE(s.sort_order, 9999) ASC,
          s.name ASC
        LIMIT $2
        `,
        [tenantId, limit]
      );

      if (!top.length) {
        return { hit: true, status: "no_match", need, ask: askWhichPlanOrService };
      }

      const options = top.map((s: any) => {
        const url =
          s.service_url && String(s.service_url).trim() ? String(s.service_url).trim() : null;

        return {
          kind: "service" as const,
          service_id: String(s.id),
          label: String(s.name),
          price: servicePrice(s) ?? moneyOrNull(s.min_variant_price) ?? null,
          currency: "USD",
          duration_min: s.duration_min != null ? Number(s.duration_min) : null,
          url,
          variants_count: Number(s.variants_count || 0),
        };
      });

      return {
        hit: true,
        status: "resolved",
        need,
        facts: {
          kind: "options" as const,
          label: "CATALOG_OPTIONS",
          options,
        },
      };
    }

    // No era lista: pedir nombre
    return { hit: true, status: "no_match", need, ask: askWhichService };
  }

  const top = services[0];
  const topScore = Number(top?.score || 0);
  const secondScore = Number(services[1]?.score || 0);

  // Ambiguo o flojo
  if (
    topScore < 0.35 ||
    (services.length >= 2 && secondScore >= 0.35 && topScore - secondScore < 0.08)
  ) {
    return {
      hit: true,
      status: "needs_clarification",
      need,
      ask: askWhichService,
      options: services.slice(0, 5).map((s: any) => ({
        label: `${s.category ? `[${s.category}] ` : ""}${s.name}`,
        kind: "service",
        service_id: String(s.id),
      })),
    };
  }

  // =========================
  // 2) Cargar variantes del top (si existen)
  // =========================
  const { rows: variants } = await pool.query(
    `
    SELECT v.id, v.variant_name, v.description,
           COALESCE(v.price_base, v.price) AS price_base,
           v.currency, v.duration_min, v.variant_url,
           v.size_token, v.min_weight_lbs, v.max_weight_lbs
    FROM service_variants v
    WHERE v.service_id = $1 AND v.active = TRUE
    ORDER BY COALESCE(v.sort_order, 9999) ASC, v.variant_name ASC
    `,
    [top.id]
  );

  const hasVariants = variants.length >= 1;

  // ✅ Si es plan/paquete, JAMÁS lo tratamos como size-based
  const isPlan = String((top as any)?.tipo || "").toLowerCase() === "plan";

  const isSizeBased = hasVariants && !isPlan ? variantsAreSizeBased(variants as any[]) : false;

  // =========================
  // 3) Comportamiento cuando hay variantes
  //    - Grooming (size-based) sin hint -> pregunta tamaño
  //    - Plan/No size-based -> devolver opciones (variantes) para que elija
  // =========================
  if (hasVariants && !mentionsVariant) {
    // ✅ grooming: pedir talla
    if (isSizeBased) {
      const ask =
        idioma === "en"
          ? `Got it — which size do you need for ${top.name}? (Small / Medium / Large)`
          : `Perfecto — ¿qué tamaño necesitas para ${top.name}? (Pequeño / Mediano / Grande)`;

      return {
        hit: true,
        status: "needs_clarification",
        need,
        ask,
        ctxPatch: {
          last_service_ref: {
            kind: "service",
            label: String(top.name),
            service_id: String(top.id),
            variant_id: null,
            saved_at: new Date().toISOString(),
          },
        },
      };
    }

    // ✅ Plan / opciones: devolver lista de variantes (con precio/descr/duración)
    const options = variants.slice(0, limit).map((v: any) => ({
      kind: "variant" as const,
      service_id: String(top.id),
      variant_id: String(v.id),
      label: `${top.name} - ${v.variant_name}`,
      price: variantPrice(v) ?? servicePrice(top),
      currency: toCurrency(v.currency || "USD"),
      duration_min:
        v.duration_min != null
          ? Number(v.duration_min)
          : top.duration_min != null
          ? Number(top.duration_min)
          : null,
      url: v.variant_url || top.service_url || null,
    }));

    // ✅ Si el usuario pidió "price/includes/duration" pero no especificó variante:
    // devolvemos opciones para que elija (esto es EXACTAMENTE lo que quieres)
    return {
      hit: true,
      status: "resolved",
      need,
      facts: {
        kind: "options" as const,
        label: String(top.name),
        service_id: String(top.id),
        options,
      },
      ctxPatch: {
        last_service_ref: {
          kind: "service",
          label: String(top.name),
          service_id: String(top.id),
          variant_id: null,
          saved_at: new Date().toISOString(),
        },
      },
    };
  }

  // =========================
  // 4) Elegir variante (si aplica) cuando el user sí dio hint (size/peso/keyword)
  // =========================
  let pickedVariant: any = null;

  if (hasVariants) {
    // grooming: match por size_token si aplica
    if (!isPlan && isSizeBased && sizeToken) {
      pickedVariant = variants.find((vv: any) => String(vv.size_token || "") === sizeToken);
      if (!pickedVariant) {
        pickedVariant = variants.find(
          (vv: any) =>
            looksLikeSizeTierName(String(vv.variant_name || "")) &&
            String(vv.variant_name || "").toLowerCase().includes(sizeToken)
        );
      }
    }

    // fallback: primero
    if (!pickedVariant) pickedVariant = variants[0];
  }

  // =========================
  // 5) Construir facts finales (service o variant)
  // =========================
  const facts =
    hasVariants && pickedVariant
      ? {
          kind: "variant" as const,
          label: `${top.name} - ${pickedVariant.variant_name}`,
          service_id: String(top.id),
          variant_id: String(pickedVariant.id),
          price: variantPrice(pickedVariant) ?? servicePrice(top),
          currency: toCurrency(pickedVariant.currency || "USD"),
          duration_min:
            pickedVariant.duration_min != null
              ? Number(pickedVariant.duration_min)
              : top.duration_min != null
              ? Number(top.duration_min)
              : null,
          description:
            pickedVariant.description
              ? String(pickedVariant.description)
              : top.description
              ? String(top.description)
              : null,
          url: pickedVariant.variant_url || top.service_url || null,
        }
      : {
          kind: "service" as const,
          label: String(top.name),
          service_id: String(top.id),
          variant_id: null,
          price: servicePrice(top),
          currency: "USD",
          duration_min: top.duration_min != null ? Number(top.duration_min) : null,
          description: top.description ? String(top.description) : null,
          url: top.service_url || null,
        };

  return {
    hit: true,
    status: "resolved",
    need,
    facts,
    ctxPatch: {
      last_service_ref: {
        kind: facts.kind,
        label: (facts as any).label,
        service_id: (facts as any).service_id,
        variant_id: (facts as any).variant_id || null,
        saved_at: new Date().toISOString(),
      },
    },
  };
}
