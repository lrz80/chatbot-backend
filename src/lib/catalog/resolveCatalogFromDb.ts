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

export async function resolveCatalogFromDb(args: {
  pool: Pool;
  tenantId: string;
  userInput: string;
  need: CatalogNeed;
  idioma: Lang;
  lastRef?: any; // ctx?.last_service_ref
  limit?: number; // ✅ para "lista de precios/planes" y opciones
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

  if (!q) {
    return { hit: true, status: "no_match", need, ask: askWhichPlanOrService };
  }

  // =========================
  // 0) Si el usuario está dando hint de variante (tamaño/peso) y hay lastRef fresco
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

    const { rows: variants } = await pool.query(
      `
      SELECT v.id, v.variant_name, v.description, v.price, v.currency, v.duration_min, v.variant_url,
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

    // 1) match por peso
    if (weightLbs != null) {
      picked = variants.find((v: any) => {
        const max = v.max_weight_lbs != null ? Number(v.max_weight_lbs) : null;
        const min = v.min_weight_lbs != null ? Number(v.min_weight_lbs) : null;
        if (max != null && weightLbs > max) return false;
        if (min != null && weightLbs < min) return false;
        return true;
      });
    }

    // 2) match por size_token
    if (!picked && sizeToken) {
      picked = variants.find((v: any) => String(v.size_token || "") === sizeToken);
    }

    // 3) fallback
    if (!picked) picked = variants[0];

    const { rows: srows } = await pool.query(
      `
      SELECT id, name, description, duration_min, price_base, service_url
      FROM services
      WHERE tenant_id = $1 AND id = $2 AND active = TRUE
      LIMIT 1
      `,
      [tenantId, serviceId]
    );

    const s = srows[0];
    if (s && picked) {
      const facts = {
        kind: "variant" as const,
        label: `${s.name} - ${picked.variant_name}`,
        service_id: String(s.id),
        variant_id: String(picked.id),
        price: moneyOrNull(picked.price) ?? moneyOrNull(s.price_base),
        currency: toCurrency(picked.currency || "USD"),
        duration_min: moneyOrNull(picked.duration_min) ?? moneyOrNull(s.duration_min),
        description: picked.description ? String(picked.description) : (s.description ? String(s.description) : null),
        url: picked.variant_url || s.service_url || null,
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
  // 1B) Si no hay match y el usuario pidió precios/planes/lista -> devolver LISTA global
  // =========================
  if (!services.length) {
    // Aquí asumimos que CatalogNeed puede incluir casos tipo "list" o "price".
    // Si tu CatalogNeed es diferente, ajusta esta condición en catalogBrain para pasar need correcto.
    const isListishNeed = String(need).includes("list") || String(need).includes("price") || String(need).includes("plans");

    if (isListishNeed) {
      const { rows: top } = await pool.query(
        `
        SELECT s.id, s.name, s.category, s.tipo, s.price_base, s.duration_min, s.service_url,
               (SELECT MIN(v.price) FROM service_variants v WHERE v.service_id = s.id AND v.active = TRUE) AS min_variant_price,
               (SELECT COUNT(*) FROM service_variants v WHERE v.service_id = s.id AND v.active = TRUE) AS variants_count
        FROM services s
        WHERE s.tenant_id = $1 AND s.active = TRUE
        ORDER BY
          CASE WHEN s.tipo = 'plan' THEN 0 ELSE 1 END,
          s.name ASC
        LIMIT $2
        `,
        [tenantId, limit]
      );

      if (!top.length) {
        return { hit: true, status: "no_match", need, ask: askWhichPlanOrService };
      }

      const options = top.map((s: any) => {
      const price =
        moneyOrNull(s.price_base) ??
        moneyOrNull(s.min_variant_price) ??
        null;

      const url =
        s.service_url && String(s.service_url).trim()
        ? String(s.service_url).trim()
        : null;

      return {
        kind: "service" as const, // ✅
        service_id: String(s.id),
        label: `${s.tipo === "plan" ? "Plan" : "Servicio"}: ${s.name}`,
        price,
        currency: "USD",
        duration_min: s.duration_min != null ? Number(s.duration_min) : null,
        url, // ✅ string|null
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

    // No era lista/precio: pedir nombre
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
  // 2) Cargar variantes del top
  // =========================
  const { rows: variants } = await pool.query(
    `
    SELECT v.id, v.variant_name, v.description, v.price, v.currency, v.duration_min, v.variant_url,
           v.size_token, v.min_weight_lbs, v.max_weight_lbs
    FROM service_variants v
    WHERE v.service_id = $1 AND v.active = TRUE
    ORDER BY v.variant_name ASC
    `,
    [top.id]
  );

  const hasVariants = variants.length >= 1;

    // ✅ Si es plan/paquete, JAMÁS lo tratamos como size-based (Synergy)
    const isPlan = String((top as any)?.tipo || "").toLowerCase() === "plan";

    const isSizeBased =
    hasVariants && !isPlan
        ? variantsAreSizeBased(variants as any[])
        : false;

  // =========================
  // 3) Si tiene variantes:
  // - Si SON tamaños y el user no dio hint -> PREGUNTAR tamaño (solo grooming)
  // - Si NO son tamaños -> DEVOLVER lista de opciones con precios (Synergy planes/paquetes)
  // =========================
  if (hasVariants && !mentionsVariant) {
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

    // ✅ NO size-based (planes/paquetes): devolvemos lista de variantes + precios sin preguntar nada
    const options = variants.slice(0, limit).map((v: any) => ({
    kind: "variant" as const, // ✅
    service_id: String(top.id),
    variant_id: String(v.id),
    label: `${top.name} - ${v.variant_name}`,
    price: moneyOrNull(v.price) ?? moneyOrNull(top.price_base),
    currency: toCurrency(v.currency || "USD"),
    duration_min:
        v.duration_min != null
        ? Number(v.duration_min)
        : (top.duration_min != null ? Number(top.duration_min) : null),
    url: v.variant_url || top.service_url || null,
    }));

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
    // Si hay size token explícito y las variantes son size-based, intentamos match
    if (isSizeBased && sizeToken) {
      pickedVariant = variants.find((vv: any) => String(vv.size_token || "") === sizeToken);
      if (!pickedVariant) {
        // fallback por nombre
        pickedVariant = variants.find((vv: any) => looksLikeSizeTierName(String(vv.variant_name || "")) && String(vv.variant_name || "").toLowerCase().includes(sizeToken));
      }
    }

    // Si NO size-based o no hubo match -> primer variante
    if (!pickedVariant) pickedVariant = variants[0];
  }

  // =========================
  // 5) Construir facts finales
  // =========================
  const facts =
    hasVariants && pickedVariant
      ? {
          kind: "variant" as const,
          label: `${top.name} - ${pickedVariant.variant_name}`,
          service_id: String(top.id),
          variant_id: String(pickedVariant.id),
          price: moneyOrNull(pickedVariant.price) ?? moneyOrNull(top.price_base),
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
          price: moneyOrNull(top.price_base),
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
