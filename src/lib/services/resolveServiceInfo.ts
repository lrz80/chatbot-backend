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

function normalizeQuery(q: string) {
  let s = String(q || "").toLowerCase();
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
    duration_min: r.vdur !== null ? Number(r.vdur) : (r.duration_min !== null ? Number(r.duration_min) : null),
    description: (r.vdesc && String(r.vdesc).trim()) ? String(r.vdesc) : (r.description ? String(r.description) : null),
    service_id: String(r.id),
    variant_id: String(r.variant_id),
  };
}

function userMentionsVariant(qRaw: string) {
  const src = String(qRaw || "");
  return (
    /\b(small|medium|large|xl|xxl)\b/i.test(src) ||
    /\b(pequeñ[oa]s?|median[oa]s?|grand[ea]s?)\b/i.test(src) ||
    /\b(\d+\s*(lb|lbs|pounds|kg))\b/i.test(src) ||
    /\b(\d+\s*-\s*\d+)\b/.test(src) ||
    /\b(\d+\+)\b/.test(src)
  );
}

export async function resolveServiceInfo(args: {
  tenantId: string;
  query: string;
  limit?: number;
}): Promise<ResolvedServiceInfo> {
  const tenantId = args.tenantId;
  const qRaw = String(args.query || "").trim();
  const q = normalizeQuery(qRaw);
  const limit = Math.min(args.limit ?? 5, 10);

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

  // 2) Ambiguo por scores (igual que link)
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

  // ✅ regla: si hay 2+ variantes y el user NO especificó -> pedir elección
  if (hasMultipleVariants && !mentions) {
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
      [top.id, q]
    );

    if (variants.length) {
      const v = variants[0];
      const url = (v.variant_url || top.service_url || null) as string | null;

      return {
        ok: true,
        kind: "variant",
        label: `${top.name} - ${v.variant_name}`,
        url,
        price: v.price !== null ? Number(v.price) : null,
        currency: v.currency ? String(v.currency) : "USD",
        duration_min: v.duration_min !== null ? Number(v.duration_min) : (top.duration_min !== null ? Number(top.duration_min) : null),
        description: (v.description && String(v.description).trim()) ? String(v.description) : (top.description ? String(top.description) : null),
        service_id: String(top.id),
        variant_id: String(v.id),
      };
    }
  }

  // 5) Si el service base NO tiene precio y NO tiene variantes, intenta fallback a paquetes con precio
  const servicePrice = top.price_base !== null ? Number(top.price_base) : null;
  const hasAnyVariant = allVariants.length > 0;

  if ((servicePrice === null || servicePrice <= 0) && !hasAnyVariant) {
    const fb = await fallbackToPricedPackage(tenantId);
    if (fb) return fb;
  }

  // 6) Sin match de variante (o no hay variantes): devolver service base
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
