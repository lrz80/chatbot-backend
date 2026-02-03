import pool from "../../lib/db";

type ResolvedLink =
  | { ok: true; url: string; label: string; kind: "service" | "variant" }
  | { ok: false; reason: "no_match" | "ambiguous"; options?: { label: string; url?: string | null }[] };

export async function resolveServiceLink(args: {
  tenantId: string;
  query: string;
  limit?: number;
}): Promise<ResolvedLink> {
  const tenantId = args.tenantId;
  const q = String(args.query || "").trim();
  const limit = Math.min(args.limit ?? 5, 10);

  if (!tenantId || !q) return { ok: false, reason: "no_match" };

  // 1) Buscar el mejor servicio por similitud (mismo SQL del endpoint search)
  const { rows: services } = await pool.query(
    `
    SELECT s.*,
           GREATEST(similarity(s.name, $2), similarity(s.description, $2)) AS score
    FROM services s
    WHERE s.tenant_id = $1
      AND s.active = TRUE
      AND (s.name % $2 OR s.description % $2)
    ORDER BY score DESC, s.name ASC
    LIMIT $3
    `,
    [tenantId, q, limit]
  );

  if (!services.length) return { ok: false, reason: "no_match" };

  const top = services[0];
  const topScore = Number(top.score || 0);

  // 2) Si score es bajo, consideramos ambiguo
  // Ajuste práctico: 0.35 suele ser buen umbral con pg_trgm
  if (topScore < 0.35) {
    return {
      ok: false,
      reason: "ambiguous",
      options: services.slice(0, 5).map((s: any) => ({
        label: `${s.category ? `[${s.category}] ` : ""}${s.name}`,
        url: s.service_url,
      })),
    };
  }

  // 3) Si el servicio tiene variantes, intentar resolver variante por nombre
  const { rows: variants } = await pool.query(
    `
    SELECT v.*,
           similarity(v.variant_name, $2) AS vscore
    FROM service_variants v
    WHERE v.service_id = $1
      AND v.active = TRUE
      AND v.variant_name % $2
    ORDER BY vscore DESC, v.variant_name ASC
    LIMIT 3
    `,
    [top.id, q]
  );

  if (variants.length) {
    const v = variants[0];
    const vScore = Number(v.vscore || 0);

    // Si variante coincide razonablemente y tiene link, priorízala
    if (vScore >= 0.35 && (v.variant_url || top.service_url)) {
      const url = (v.variant_url || top.service_url) as string;
      return { ok: true, url, label: `${top.name} - ${v.variant_name}`, kind: "variant" };
    }
  }

  // 4) Si hay link del servicio, lo devolvemos
  if (top.service_url) {
    return { ok: true, url: top.service_url, label: top.name, kind: "service" };
  }

  // 5) Sin link guardado -> ambiguo/no match
  return {
    ok: false,
    reason: "ambiguous",
    options: services.slice(0, 5).map((s: any) => ({
      label: `${s.category ? `[${s.category}] ` : ""}${s.name}`,
      url: s.service_url,
    })),
  };
}
