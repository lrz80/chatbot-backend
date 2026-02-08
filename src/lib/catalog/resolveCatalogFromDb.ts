import type { Pool } from "pg";
import type { CatalogNeed, CatalogResult, Lang } from "./types";
import { pickSizeToken, userMentionsVariantHint } from "./variantHints";

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

  // 0) si el usuario está diciendo “small/pequeño” y hay lastRef fresco -> resolve dentro del mismo service
  const lastRefFresh = (() => {
    const saved = String(lastRef?.saved_at || "").trim();
    if (!saved) return false;
    const ts = Date.parse(saved);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < 1000 * 60 * 20;
  })();

  const size = pickSizeToken(q);
  const mentionsVariant = userMentionsVariantHint(q);

  if (lastRefFresh && lastRef?.service_id && mentionsVariant) {
    const serviceId = String(lastRef.service_id);

    const { rows: variants } = await pool.query(
      `
      SELECT v.id, v.variant_name, v.description, v.price, v.currency, v.duration_min, v.variant_url
      FROM service_variants v
      WHERE v.service_id = $1 AND v.active = TRUE
      ORDER BY v.variant_name ASC
      `,
      [serviceId]
    );

    if (variants.length) {
      let picked = null as any;

      if (size) {
        picked = variants.find((vv: any) => {
          const name = String(vv.variant_name || "").toLowerCase();
          if (size === "small") return /\b(small|xs|x-small|peque)\b/.test(name);
          if (size === "medium") return /\b(medium|med)\b/.test(name);
          if (size === "large") return /\b(large|grand)\b/.test(name);
          if (size === "xl") return /\b(xl|extra)\b/.test(name);
          return false;
        });
      }

      if (!picked) picked = variants[0];

      // traer service para label/url fallback
      const { rows: srows } = await pool.query(
        `SELECT id, name, description, duration_min, price_base, service_url
         FROM services
         WHERE tenant_id = $1 AND id = $2 AND active = TRUE
         LIMIT 1`,
        [tenantId, serviceId]
      );

      const s = srows[0];
      if (s) {
        const facts = {
          kind: "variant" as const,
          label: `${s.name} - ${picked.variant_name}`,
          service_id: String(s.id),
          variant_id: String(picked.id),
          price: picked.price != null ? Number(picked.price) : (s.price_base != null ? Number(s.price_base) : null),
          currency: picked.currency ? String(picked.currency) : "USD",
          duration_min: picked.duration_min != null ? Number(picked.duration_min) : (s.duration_min != null ? Number(s.duration_min) : null),
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
  }

  // 1) resolver service top por similarity (DB es fuente de verdad)
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
    [tenantId, q, 5]
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
      // si quieres guardar options para pick numérico, puedes devolver ctxPatch aquí
    };
  }

  // 2) cargar variantes del top
  const { rows: variants } = await pool.query(
    `
    SELECT v.id, v.variant_name, v.description, v.price, v.currency, v.duration_min, v.variant_url
    FROM service_variants v
    WHERE v.service_id = $1 AND v.active = TRUE
    ORDER BY v.variant_name ASC
    `,
    [top.id]
  );

  const hasVariants = variants.length >= 1;

  // 3) si tiene variantes y el user no dio hint, pedir 1 pregunta corta (sin menús)
  if (hasVariants && !mentionsVariant) {
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

  // 4) elegir variante si aplica
  let pickedVariant: any = null;
  if (hasVariants) {
    if (size) {
      pickedVariant = variants.find((vv: any) => {
        const name = String(vv.variant_name || "").toLowerCase();
        if (size === "small") return /\b(small|xs|x-small|peque)\b/.test(name);
        if (size === "medium") return /\b(medium|med)\b/.test(name);
        if (size === "large") return /\b(large|grand)\b/.test(name);
        if (size === "xl") return /\b(xl|extra)\b/.test(name);
        return false;
      });
    }
    if (!pickedVariant) pickedVariant = variants[0];
  }

  const facts = hasVariants && pickedVariant
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
        variant_id: facts.variant_id || null,
        saved_at: new Date().toISOString(),
      },
    },
  };
}
