// backend/src/lib/catalog/resolveCatalogFromDb.ts
import type { Pool } from "pg";
import type { CatalogNeed, CatalogResult, Lang } from "./types";
import { userMentionsVariantHint } from "./variantHints";
import { inferSizeTokenFromText, inferWeightLbsFromText } from "./normalizeSize";

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

  // ===============================
  // 0) lastRef fresco + user dio hint de variante (small/pequeño o peso)
  // ===============================
  const lastRefFresh = (() => {
    const saved = String(lastRef?.saved_at || "").trim();
    if (!saved) return false;
    const ts = Date.parse(saved);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < 1000 * 60 * 20;
  })();

  const sizeToken = inferSizeTokenFromText(q); // "small"|"medium"|"large"|"xl"|null
  const weightLbs = inferWeightLbsFromText(q); // number|null
  const mentionsVariant = userMentionsVariantHint(q) || !!sizeToken || !!weightLbs;

  if (lastRefFresh && lastRef?.service_id && mentionsVariant) {
    const serviceId = String(lastRef.service_id);

    const { rows: variants } = await pool.query(
      `
      SELECT
        v.id, v.variant_name, v.description, v.price, v.currency, v.duration_min, v.variant_url,
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
        // 1) por columna size_token si existe
        picked = variants.find((v: any) => String(v.size_token || "") === sizeToken);

        // 2) fallback por nombre si size_token está NULL
        if (!picked) {
           picked = variants.find((v: any) => {
            const name = String(v.variant_name || "").toLowerCase();
            if (sizeToken === "small") return /\b(small|peque|toy|mini|xs)\b/.test(name);
            if (sizeToken === "medium") return /\b(medium|mediano|md)\b/.test(name);
            if (sizeToken === "large") return /\b(large|grande|lg)\b/.test(name);
            if (sizeToken === "xl") return /\b(xl|extra\s*large|gigante)\b/.test(name);
            return false;
          });
        }
      }

      // 3) fallback estable
      if (!picked) picked = variants[0];

      // traer service para label/url fallback
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
      if (s) {
        const facts = {
          kind: "variant" as const,
          label: `${s.name} - ${picked.variant_name}`,
          service_id: String(s.id),
          variant_id: String(picked.id),
          price:
            picked.price != null
              ? Number(picked.price)
              : s.price_base != null
                ? Number(s.price_base)
                : null,
          currency: picked.currency ? String(picked.currency) : "USD",
          duration_min:
            picked.duration_min != null
              ? Number(picked.duration_min)
              : s.duration_min != null
                ? Number(s.duration_min)
                : null,
          description:
            picked.description
              ? String(picked.description)
              : s.description
                ? String(s.description)
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

    // si no hay variantes o no pudo resolver, cae al resolver normal por service
  }

  // ===============================
  // 1) resolver service top por similarity (DB es fuente de verdad)
  // ===============================
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

  // si muy flojo o muy cerca -> pedir aclaración (1 pregunta)
  if (
    topScore < 0.35 ||
    (services.length >= 2 && secondScore >= 0.35 && topScore - secondScore < 0.08)
  ) {
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

  // ===============================
  // 2) cargar variantes del top (con columnas normalizadas)
  // ===============================
  const { rows: variants } = await pool.query(
    `
    SELECT
      v.id, v.variant_name, v.description, v.price, v.currency, v.duration_min, v.variant_url,
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

  // ===============================
  // 3) si tiene variantes y el user no dio hint, pedir 1 pregunta corta
  // ===============================
  if (hasVariants && !mentionsVariant) {
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

  // ===============================
  // 4) elegir variante si aplica (peso > size_token > fallback)
  // ===============================
  let pickedVariant: any = null;

  if (hasVariants) {
    if (weightLbs != null) {
      pickedVariant = variants.find((v: any) => {
        const max = v.max_weight_lbs != null ? Number(v.max_weight_lbs) : null;
        const min = v.min_weight_lbs != null ? Number(v.min_weight_lbs) : null;

        if (max != null && weightLbs > max) return false;
        if (min != null && weightLbs < min) return false;
        return true;
      });
    }

    if (!pickedVariant && sizeToken) {
      pickedVariant = variants.find((v: any) => String(v.size_token || "") === sizeToken);
    }

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
            pickedVariant.price != null
              ? Number(pickedVariant.price)
              : top.price_base != null
                ? Number(top.price_base)
                : null,
          currency: pickedVariant.currency ? String(pickedVariant.currency) : "USD",
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
