import type { Pool } from "pg";
import type { CatalogNeed, CatalogResult, Lang } from "./types";
import { userMentionsVariantHint } from "./variantHints";
import { inferSizeTokenFromText, inferWeightLbsFromText } from "./normalizeSize";

/** ===== helpers ===== */
function isFresh(savedAt?: any, minutes = 20) {
  const saved = String(savedAt || "").trim();
  if (!saved) return false;
  const ts = Date.parse(saved);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < 1000 * 60 * minutes;
}

function variantsLookLikeSizeOrWeight(variants: any[]) {
  // ✅ Solo consideramos “size” si hay señales reales en DB o en el nombre
  for (const v of variants || []) {
    if (v?.size_token) return true;
    if (v?.min_weight_lbs != null || v?.max_weight_lbs != null) return true;

    const name = String(v?.variant_name || "").toLowerCase();
    if (/\b(small|medium|large|xl|x-large|xs|x-small|peque(ñ|n)o|mediano|grande)\b/.test(name)) {
      return true;
    }
    if (/\b(\d{1,3})\s?(lb|lbs|libras)\b/.test(name)) {
      return true;
    }
  }
  return false;
}

function moneyLabel(v: any) {
  const price =
    v?.price != null && Number.isFinite(Number(v.price)) ? Number(v.price) : null;
  const cur = v?.currency ? String(v.currency).toUpperCase() : "USD";
  if (price == null) return null;
  return cur === "USD" ? `$${price}` : `${price} ${cur}`;
}

function pickVariantBySizeOrWeight(args: {
  variants: any[];
  sizeToken: string | null;
  weightLbs: number | null;
}) {
  const { variants, sizeToken, weightLbs } = args;
  if (!variants?.length) return null;

  // 1) match por peso
  if (weightLbs != null) {
    const hit = variants.find((v: any) => {
      const max = v.max_weight_lbs != null ? Number(v.max_weight_lbs) : null;
      const min = v.min_weight_lbs != null ? Number(v.min_weight_lbs) : null;
      if (max != null && weightLbs > max) return false;
      if (min != null && weightLbs < min) return false;
      return true;
    });
    if (hit) return hit;
  }

  // 2) match por size_token (si existe en DB)
  if (sizeToken) {
    const hit = variants.find((v: any) => String(v.size_token || "") === sizeToken);
    if (hit) return hit;

    // 3) fallback por texto en nombre si no hay size_token poblado
    const hit2 = variants.find((v: any) => {
      const name = String(v.variant_name || "").toLowerCase();
      if (sizeToken === "small") return /\b(small|xs|x-small|peque)\b/.test(name);
      if (sizeToken === "medium") return /\b(medium|med|mediano)\b/.test(name);
      if (sizeToken === "large") return /\b(large|grand|grande)\b/.test(name);
      if (sizeToken === "xl") return /\b(xl|x-large|extra)\b/.test(name);
      return false;
    });
    if (hit2) return hit2;
  }

  return variants[0]; // fallback estable
}

export async function resolveCatalogFromDb(args: {
  pool: Pool;
  tenantId: string;
  userInput: string;
  need: CatalogNeed;
  idioma: Lang;
  lastRef?: any; // ctx?.last_service_ref
}): Promise<CatalogResult> {
  const { pool, tenantId, userInput, need, idioma, lastRef } = args;

  const q = String(userInput || "").trim();
  if (!q) {
    return {
      hit: true,
      status: "no_match",
      need,
      ask: idioma === "en" ? "Which service do you mean?" : "¿De cuál servicio hablas?",
    };
  }

  const lastRefFresh = isFresh(lastRef?.saved_at, 20);

  const sizeToken = inferSizeTokenFromText(q);    // "small"|"medium"|"large"|"xl"|null
  const weightLbs = inferWeightLbsFromText(q);    // number|null
  const mentionsVariant = userMentionsVariantHint(q) || !!sizeToken || !!weightLbs;

  /** =========================================================
   *  0) Si lastRef fresco + el usuario respondió una variante (size/peso/keyword)
   * ========================================================= */
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

    if (variants.length) {
      const picked = pickVariantBySizeOrWeight({ variants, sizeToken, weightLbs });

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
          price:
            picked.price != null ? Number(picked.price)
            : s.price_base != null ? Number(s.price_base)
            : null,
          currency: picked.currency ? String(picked.currency) : "USD",
          duration_min:
            picked.duration_min != null ? Number(picked.duration_min)
            : s.duration_min != null ? Number(s.duration_min)
            : null,
          description:
            picked.description ? String(picked.description)
            : s.description ? String(s.description)
            : null,
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
  }

  /** =========================================================
   *  1) Resolver service top por similarity (DB)
   *  ✅ FIX: SOLO 2 params (tenantId, q)
   * ========================================================= */
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

  if (!services.length) {
    return {
      hit: true,
      status: "no_match",
      need,
      ask:
        idioma === "en"
          ? "Which service exactly? Tell me the name."
          : "¿Cuál servicio exactamente? Dime el nombre.",
    };
  }

  const top = services[0];
  const topScore = Number(top?.score || 0);
  const secondScore = Number(services[1]?.score || 0);

  if (topScore < 0.35 || (services.length >= 2 && secondScore >= 0.35 && topScore - secondScore < 0.08)) {
    const ask =
      idioma === "en"
        ? "Which one do you mean? Tell me the service name."
        : "¿Cuál de estos? Dime el nombre del servicio.";

    return {
      hit: true,
      status: "needs_clarification",
      need,
      ask,
      options: services.slice(0, 5).map((s: any) => ({
        label: `${s.category ? `[${s.category}] ` : ""}${s.name}`,
        kind: "service",
        service_id: String(s.id),
      })),
    };
  }

  /** =========================================================
   *  2) Cargar variantes del top
   * ========================================================= */
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
    [top.id]
  );

  const hasVariants = variants.length >= 1;
  const sizeBased = hasVariants ? variantsLookLikeSizeOrWeight(variants) : false;

  /** =========================================================
   *  3) Si tiene variantes y el user NO dio hint:
   *     ✅ NO preguntes size SI NO ES size-based
   *     ✅ Si need=price, devuelve precios por variante (top 5)
   * ========================================================= */
  if (hasVariants && !mentionsVariant) {
    // ✅ Caso A: variantes son por size/peso => pregunta size
    if (sizeBased) {
      const ask =
        idioma === "en"
          ? `Got it — which size do you need for ${top.name}? (Small / Medium / Large)`
          : `Perfecto — ¿qué tamaño necesitas para ${top.name}? (Small / Medium / Large)`;

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

    // ✅ Caso B: NO es size-based (planes, paquetes, opciones)
    // Si el usuario pidió precio: responde con lista de precios por variante (sin preguntar size)
    if (need === "price") {
      const lines = variants.slice(0, 6).map((v: any) => {
        const price = moneyLabel(v);
        const name = String(v.variant_name || "Opción");
        return price ? `• ${name}: ${price}` : `• ${name}: (precio no cargado)`;
      });

      const ask =
        idioma === "en"
          ? `Here are the prices for ${top.name}:\n${lines.join("\n")}\nWhich option would you like?`
          : `Aquí tienes los precios de ${top.name}:\n${lines.join("\n")}\n¿Cuál opción te interesa?`;

      return {
        hit: true,
        status: "needs_clarification",
        need,
        ask,
        options: variants.slice(0, 6).map((v: any) => ({
          label: `${v.variant_name}${moneyLabel(v) ? ` — ${moneyLabel(v)}` : ""}`,
          kind: "variant",
          service_id: String(top.id),
          variant_id: String(v.id),
        })),
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

    // Si el need no es price: pide cuál opción/variante quiere
    const ask =
      idioma === "en"
        ? `Which option for ${top.name} do you mean?`
        : `¿Cuál opción de ${top.name} exactamente?`;

    return {
      hit: true,
      status: "needs_clarification",
      need,
      ask,
      options: variants.slice(0, 6).map((v: any) => ({
        label: String(v.variant_name),
        kind: "variant",
        service_id: String(top.id),
        variant_id: String(v.id),
      })),
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

  /** =========================================================
   *  4) Elegir variante si aplica (solo si hay size/peso o el user ya dio hint)
   * ========================================================= */
  let pickedVariant: any = null;

  if (hasVariants) {
    // Si es size-based o el user dio hint, intentamos pick.
    if (sizeBased || mentionsVariant) {
      pickedVariant = pickVariantBySizeOrWeight({ variants, sizeToken, weightLbs });
    }

    // Si no pudimos elegir, fallback estable
    if (!pickedVariant) pickedVariant = variants[0];
  }

  const facts =
    hasVariants && pickedVariant
      ? {
          kind: "variant" as const,
          label: `${top.name} - ${pickedVariant.variant_name}`,
          service_id: String(top.id),
          variant_id: String(pickedVariant.id),
          price:
            pickedVariant.price != null ? Number(pickedVariant.price)
            : top.price_base != null ? Number(top.price_base)
            : null,
          currency: pickedVariant.currency ? String(pickedVariant.currency) : "USD",
          duration_min:
            pickedVariant.duration_min != null ? Number(pickedVariant.duration_min)
            : top.duration_min != null ? Number(top.duration_min)
            : null,
          description:
            pickedVariant.description ? String(pickedVariant.description)
            : top.description ? String(top.description)
            : null,
          url: pickedVariant.variant_url || top.service_url || null,
        }
      : {
          kind: "service" as const,
          label: String(top.name),
          service_id: String(top.id),
          variant_id: null,
          price: top.price_base != null ? Number(top.price_base) : null,
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
        label: facts.label,
        service_id: facts.service_id,
        variant_id: (facts as any).variant_id || null,
        saved_at: new Date().toISOString(),
      },
    },
  };
}
