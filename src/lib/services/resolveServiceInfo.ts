// src/lib/services/resolveServiceInfo.ts

import pool from "../../lib/db";

export type ResolvedServiceInfo =
  | {
      ok: true;
      kind: "service" | "variant";
      label: string;
      url: string | null;
      price: number | null;
      currency: string | null; // variants tienen currency, services no (puedes default "USD")
      duration_min: number | null;
      description: string | null;
      service_id: string;
      variant_id?: string;
    }
  | {
      ok: false;
      reason: "no_match" | "ambiguous";
      options?: Array<{
        label: string;
        // para cuando el usuario elige 1/2/3
        kind: "service" | "variant";
        service_id: string;
        variant_id?: string;
      }>;
    };

export type ServiceInfoNeed = "price" | "duration" | "includes" | "any";

function stripDiacritics(s: string) {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function normalizeQuery(q: string) {
  let s = String(q || "").toLowerCase();
  s = stripDiacritics(s);

  // quita ruido universal
  s = s.replace(
    /\b(mandame|mándame|pasame|pásame|env[ií]ame|enviame|dame|quiero|necesito|me\s+das|me\s+puedes|puedes|por\s+favor|pf|pls|please|send\s+me|send|link|enlace|url|reservar|reserva|agendar|agenda|book|booking|schedule|precio|cost|price|cuesta|dura|duration|incluye|includes)\b/g,
    " "
  );
  s = s.replace(
    /\b(el|la|los|las|un|una|unos|unas|de|del|al|para|por|con|sin|y|o|que|es|en|the|a|an|of|for|to|and|or|is|in|on)\b/g,
    " "
  );
  s = s.replace(/[^\p{L}\p{N}\s-]+/gu, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function buildVariantQuery(qRaw: string) {
  const src = stripDiacritics(String(qRaw || "").toLowerCase());

  // tokens base normalizados (sin ruido)
  const base = normalizeQuery(src);

  // hints universales de tamaño (ES/EN)
  const hints: string[] = [];

  if (/\b(pequeno|pequena|pequenos|pequenas|small|xs|x-small)\b/i.test(src)) hints.push("small xs");
  if (/\b(mediano|mediana|medianos|medianas|medium|m)\b/i.test(src)) hints.push("medium m");
  if (/\b(grande|grandes|large|l)\b/i.test(src)) hints.push("large l");
  if (/\b(xl|extra\s*large|extra-large)\b/i.test(src)) hints.push("xl extra large");

  // pesos / rangos comunes (universales)
  // ej: "10 lbs", "5-10", "20+"
  if (/\b\d+\s*(lb|lbs|pounds|kg)\b/i.test(src)) hints.push("weight");
  if (/\b\d+\s*-\s*\d+\b/.test(src)) hints.push("range");
  if (/\b\d+\+\b/.test(src)) hints.push("plus");

  const enriched = [base, ...hints].join(" ").replace(/\s+/g, " ").trim();
  return enriched || base;
}

async function fallbackToPricedPackage(tenantId: string): Promise<ResolvedServiceInfo | null> {
  // Busca un item “paquetes/credits/classes” que tenga variantes con precio
  const { rows } = await pool.query(
    `
    SELECT s.id, s.name, s.description, s.duration_min, s.service_url,
           v.id AS variant_id, v.variant_name, v.description AS vdesc,
           v.price, v.currency, v.duration_min AS vdur, v.variant_url
    FROM services s
    JOIN service_variants v ON v.service_id = s.id AND v.active = TRUE
    WHERE s.tenant_id = $1
      AND s.active = TRUE
      AND (
        lower(s.name) LIKE '%package%' OR
        lower(s.name) LIKE '%paquete%' OR
        lower(s.name) LIKE '%credit%' OR
        lower(s.name) LIKE '%class%'
      )
      AND v.price IS NOT NULL
    ORDER BY s.name ASC, v.price ASC NULLS LAST
    LIMIT 1
    `,
    [tenantId]
  );

  const r = rows[0];
  if (!r) return null;

  const url = (r.variant_url || r.service_url || null) as string | null;

  return {
    ok: true,
    kind: "variant",
    label: `${r.name} - ${r.variant_name}`,
    url,
    price: r.price !== null ? Number(r.price) : null,
    currency: r.currency ? String(r.currency) : "USD",
    duration_min:
      r.vdur !== null
        ? Number(r.vdur)
        : r.duration_min !== null
          ? Number(r.duration_min)
          : null,
    description:
      r.vdesc && String(r.vdesc).trim()
        ? String(r.vdesc)
        : r.description
          ? String(r.description)
          : null,
    service_id: String(r.id),
    variant_id: String(r.variant_id),
  };
}

function userMentionsVariant(qRaw: string) {
  const src = stripDiacritics(String(qRaw || "").toLowerCase());
  return (
    /\b(small|medium|large|xl|xxl|xs|x-small)\b/i.test(src) ||
    /\b(pequeno|pequena|pequenos|pequenas|mediano|mediana|medianos|medianas|grande|grandes)\b/i.test(src) ||
    /\b(\d+\s*(lb|lbs|pounds|kg))\b/i.test(src) ||
    /\b(\d+\s*-\s*\d+)\b/.test(src) ||
    /\b(\d+\+)\b/.test(src)
  );
}

function toServiceResult(top: any): ResolvedServiceInfo {
  const servicePrice = top.price_base !== null ? Number(top.price_base) : null;
  return {
    ok: true,
    kind: "service",
    label: String(top.name),
    url: top.service_url ? String(top.service_url) : null,
    price: servicePrice,
    currency: "USD",
    duration_min: top.duration_min !== null ? Number(top.duration_min) : null,
    description: top.description ? String(top.description) : null,
    service_id: String(top.id),
  };
}

export async function resolveServiceInfo(args: {
  tenantId: string;
  query: string;
  need?: ServiceInfoNeed; // ✅ NUEVO
  limit?: number;
}): Promise<ResolvedServiceInfo> {
  const tenantId = args.tenantId;
  const qRaw = String(args.query || "").trim();
  const q = normalizeQuery(qRaw);
  const limit = Math.min(args.limit ?? 5, 10);
  const need: ServiceInfoNeed = args.need ?? "any";

  if (!tenantId || !q) return { ok: false, reason: "no_match" };

  // 1) Top service por similitud
  const { rows: services } = await pool.query(
    `
    SELECT s.*,
           GREATEST(similarity(s.name, $2), similarity(COALESCE(s.description,''), $2)) AS score
    FROM services s
    WHERE s.tenant_id = $1
      AND s.active = TRUE
      AND (s.name % $2 OR COALESCE(s.description,'') % $2)
    ORDER BY score DESC, s.name ASC
    LIMIT $3
    `,
    [tenantId, q, limit]
  );

  if (!services.length) return { ok: false, reason: "no_match" };

  const top = services[0];
  const topScore = Number(top?.score || 0);
  const second = services[1];
  const secondScore = Number(second?.score || 0);

  // 2) Ambiguo por scores
  if (topScore < 0.35) {
    return {
      ok: false,
      reason: "ambiguous",
      options: services.slice(0, 5).map((s: any) => ({
        label: `${s.category ? `[${s.category}] ` : ""}${s.name}`,
        kind: "service",
        service_id: s.id,
      })),
    };
  }

  if (services.length >= 2 && secondScore >= 0.35) {
    const gap = topScore - secondScore;
    // ✅ solo ambiguo si están realmente cerca
    if (gap < 0.08) {
      return {
        ok: false,
        reason: "ambiguous",
        options: services.slice(0, 5).map((s: any) => ({
          label: `${s.category ? `[${s.category}] ` : ""}${s.name}`,
          kind: "service",
          service_id: s.id,
        })),
      };
    }
  }

  // 3) Traer TODAS las variantes activas del top (siempre)
  const { rows: allVariants } = await pool.query(
    `
    SELECT v.*
    FROM service_variants v
    WHERE v.service_id = $1
      AND v.active = TRUE
    ORDER BY v.variant_name ASC
    `,
    [top.id]
  );

  const hasMultipleVariants = allVariants.length >= 2;
  const mentions = userMentionsVariant(qRaw);

  // ✅ FIX: Si hay 2+ variantes y el user NO especificó:
  // - Para PRICE: pedir variante (si el service base no tiene precio)
  // - Para INCLUDES/DURATION: responder service base si tiene data útil;
  //   si NO tiene data útil, entonces sí pedir variante.
  if (hasMultipleVariants && !mentions) {
    const serviceHasUsefulDescription = !!(top.description && String(top.description).trim());
    const serviceHasUsefulDuration =
      top.duration_min !== null && Number.isFinite(Number(top.duration_min));
    const serviceHasUsefulPrice =
      top.price_base !== null && Number.isFinite(Number(top.price_base)) && Number(top.price_base) > 0;

    const needsPrice = need === "price";
    const needsIncludes = need === "includes";
    const needsDuration = need === "duration";
    const needsAny = need === "any";

    // (A) Precio: obliga variante si el service no trae precio
    if (needsPrice && !serviceHasUsefulPrice) {
      return {
        ok: false,
        reason: "ambiguous",
        options: allVariants.slice(0, 5).map((v: any) => ({
          label: `${top.name} - ${v.variant_name}`,
          kind: "variant",
          service_id: top.id,
          variant_id: v.id,
        })),
      };
    }

    // (B) Includes: si el service tiene descripción -> responder service
    if (needsIncludes && serviceHasUsefulDescription) {
      return toServiceResult(top);
    }

    // (C) Duración: si el service tiene duración -> responder service
    if (needsDuration && serviceHasUsefulDuration) {
      return toServiceResult(top);
    }

    // (D) Any: si el service tiene algo útil -> responder service
    if (needsAny && (serviceHasUsefulDescription || serviceHasUsefulDuration || serviceHasUsefulPrice)) {
      return toServiceResult(top);
    }

    // (E) Si no hay data útil en el service base -> pedir variante
    return {
      ok: false,
      reason: "ambiguous",
      options: allVariants.slice(0, 5).map((v: any) => ({
        label: `${top.name} - ${v.variant_name}`,
        kind: "variant",
        service_id: top.id,
        variant_id: v.id,
      })),
    };
  }

  // 4) Si menciona variante, intenta escoger por similitud
  if (allVariants.length && mentions) {
    const variantQuery = buildVariantQuery(qRaw);

    const { rows: variants } = await pool.query(
      `
      SELECT v.*,
             GREATEST(
               similarity(v.variant_name, $2),
               similarity(COALESCE(v.description,''), $2)
             ) AS vscore
      FROM service_variants v
      WHERE v.service_id = $1
        AND v.active = TRUE
        AND (v.variant_name % $2 OR COALESCE(v.description,'') % $2)
      ORDER BY vscore DESC, v.variant_name ASC
      LIMIT 3
      `,
      [top.id, variantQuery]
    );

    if (variants.length) {
      const v = variants[0];
      const url = (v.variant_url || top.service_url || null) as string | null;
      const vscore = Number(v?.vscore || 0);

      // ✅ si el score es suficientemente bueno, selecciona
      if (vscore >= 0.25) {
        return {
          ok: true,
          kind: "variant",
          label: `${top.name} - ${v.variant_name}`,
          url,
          price: v.price !== null ? Number(v.price) : null,
          currency: v.currency ? String(v.currency) : "USD",
          duration_min:
            v.duration_min !== null
              ? Number(v.duration_min)
              : top.duration_min !== null
                ? Number(top.duration_min)
                : null,
          description:
            v.description && String(v.description).trim()
              ? String(v.description)
              : top.description
                ? String(top.description)
                : null,
          service_id: String(top.id),
          variant_id: String(v.id),
        };
      }
    }

    // ✅ matcher determinístico por tamaño (universal)
    const src = stripDiacritics(qRaw.toLowerCase());
    const wantsSmall = /\b(pequeno|pequena|pequenos|pequenas|small|xs|x-small)\b/.test(src);
    const wantsMedium = /\b(mediano|mediana|medianos|medianas|medium|m)\b/.test(src);
    const wantsLarge = /\b(grande|grandes|large|l)\b/.test(src);
    const wantsXL = /\b(xl|extra\s*large|extra-large)\b/.test(src);

    if (allVariants.length) {
      const pick = allVariants.find((vv: any) => {
        const name = stripDiacritics(String(vv.variant_name || "").toLowerCase());
        if (wantsSmall) return /\b(small|xs|x-small|pequeno|pequena)\b/.test(name);
        if (wantsMedium) return /\b(medium|mediano|mediana)\b/.test(name);
        if (wantsLarge) return /\b(large|grande)\b/.test(name);
        if (wantsXL) return /\b(xl|extra\s*large|extra-large)\b/.test(name);
        return false;
      });

      if (pick) {
        const url = (pick.variant_url || top.service_url || null) as string | null;
        return {
          ok: true,
          kind: "variant",
          label: `${top.name} - ${pick.variant_name}`,
          url,
          price: pick.price !== null ? Number(pick.price) : null,
          currency: pick.currency ? String(pick.currency) : "USD",
          duration_min:
            pick.duration_min !== null
              ? Number(pick.duration_min)
              : top.duration_min !== null
                ? Number(top.duration_min)
                : null,
          description:
            pick.description && String(pick.description).trim()
              ? String(pick.description)
              : top.description
                ? String(top.description)
                : null,
          service_id: String(top.id),
          variant_id: String(pick.id),
        };
      }
    }

    // ✅ mencionó variante pero no matcheó → pedir elección
    return {
      ok: false,
      reason: "ambiguous",
      options: allVariants.slice(0, 5).map((v: any) => ({
        label: `${top.name} - ${v.variant_name}`,
        kind: "variant",
        service_id: top.id,
        variant_id: v.id,
      })),
    };
  }

  // 5) Si el service base NO tiene precio y NO tiene variantes, intenta fallback a paquetes con precio
  const servicePrice = top.price_base !== null ? Number(top.price_base) : null;
  const hasAnyVariant = allVariants.length > 0;

  if ((servicePrice === null || servicePrice <= 0) && !hasAnyVariant) {
    const fb = await fallbackToPricedPackage(tenantId);
    if (fb) return fb;
  }

  // 6) Sin match de variante (o no hay variantes): devolver service base
  return toServiceResult(top);
}
