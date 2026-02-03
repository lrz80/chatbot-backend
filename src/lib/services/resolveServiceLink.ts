import pool from "../../lib/db";

type ResolvedLink =
  | { ok: true; url: string; label: string; kind: "service" | "variant" }
  | { ok: false; reason: "no_match" | "ambiguous"; options?: { label: string; url?: string | null }[] };

function normalizeServiceQuery(q: string) {
  let s = String(q || "").toLowerCase();

  // ES -> EN básicos (ajusta a tu industria)
  const map: Array<[RegExp, string]> = [
    [/\bbañ(o|os|ito|itos)\b/g, "bath"],
    [/\bpeluquer(i|í)a\b/g, "groom"],
    [/\bgrooming\b/g, "groom"],
    [/\brecorte\b/g, "trim"],
    [/\buñ(as|as)\b/g, "nails"],
    [/\bdeslanad(o|a|os|as|ado|ada)\b/g, "deshedding"],
    [/\bdeshedding\b/g, "deshedding"],
    [/\blimpieza\s+de\s+o(i|í)dos\b/g, "ears"],
    [/\bo(i|í)dos\b/g, "ears"],
    [/\bdientes\b/g, "teeth"],
    [/\bcepillad(o|a)\b/g, "brush"],
  ];
  for (const [re, repl] of map) s = s.replace(re, repl);

  // ✅ Quitar ruido típico de pedir links (ES/EN)
  s = s.replace(
    /\b(mandame|mándame|pasame|pásame|env[ií]ame|enviame|dame|necesito|quiero|me\s+das|me\s+puedes|puedes|por\s+favor|pf|pls|please|send\s+me|send|link|enlace|url|reservar|reserva|agendar|agenda|book|booking|schedule|the|a|an|of|for|to|del|de|el|la|los|las|un|una|unos|unas)\b/g,
    " "
  );

  // Limpieza final
  s = s.replace(/[^\p{L}\p{N}\s-]+/gu, " "); // quita puntuación
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

export async function resolveServiceLink(args: {
  tenantId: string;
  query: string;
  limit?: number;
}): Promise<ResolvedLink> {
  const tenantId = args.tenantId;
  const qRaw = String(args.query || "").trim();
  const q = normalizeServiceQuery(qRaw);

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

    if (!services.length) {
    // Fallback: búsqueda simple por ILIKE (por si pg_trgm no matchea)
    const tokens = q.split(" ").filter(Boolean);
    const patterns = tokens.length
    ? tokens.map((t) => `%${t}%`)
    : [`%${q}%`];

    const { rows: services2 } = await pool.query(
    `
    SELECT s.*, 0.0 AS score
    FROM services s
    WHERE s.tenant_id = $1
        AND s.active = TRUE
        AND (
        s.name ILIKE ANY($2) OR
        s.description ILIKE ANY($2)
        )
    ORDER BY s.category ASC, s.name ASC
    LIMIT $3
    `,
    [tenantId, patterns, limit]
    );

    if (!services2.length) return { ok: false, reason: "no_match" };

    // Si encontró algo, tratamos como ambiguo (para que el usuario elija 1-5)
    return {
      ok: false,
      reason: "ambiguous",
      options: services2.slice(0, 5).map((s: any) => ({
        label: `${s.category ? `[${s.category}] ` : ""}${s.name}`,
        url: s.service_url,
      })),
    };
  }

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
