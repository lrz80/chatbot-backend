import type { Pool } from "pg";

type LinkPick =
  | { ok: true; url: string }
  | { ok: false; reason: "no_link" }
  | { ok: false; reason: "ambiguous"; options: Array<{ label: string; url: string }> };

function norm(s: string) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function tokenize(s: string) {
  return norm(s)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((x) => x.length >= 2);
}

// Similitud simple por overlap (sin hardcode de keywords)
function scoreLabelVsText(label: string, userText: string) {
  const a = new Set(tokenize(label));
  const b = new Set(tokenize(userText));
  if (!a.size || !b.size) return 0;

  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;

  // Jaccard
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

export async function resolveBestLinkForService(args: {
  pool: Pool;
  tenantId: string;
  serviceId: string;
  userText?: string | null;
}): Promise<LinkPick> {
  const { pool, tenantId, serviceId, userText } = args;

  // 1) Cargar service_url (pero NO devolverlo todavía)
  const s = await pool.query(
    `
    SELECT NULLIF(TRIM(COALESCE(service_url,'')), '') AS service_url
    FROM services
    WHERE tenant_id = $1 AND id = $2 AND active = true
    LIMIT 1
    `,
    [tenantId, serviceId]
  );
  const serviceUrl = s.rows?.[0]?.service_url ? String(s.rows[0].service_url) : "";

  // 2) variant_url(s)
  const v = await pool.query(
    `
    SELECT
      COALESCE(NULLIF(TRIM(COALESCE(variant_name,'')), ''), 'Option') AS label,
      NULLIF(TRIM(COALESCE(variant_url,'')), '') AS url
    FROM service_variants
    WHERE service_id = $1
      AND active = true
      AND NULLIF(TRIM(COALESCE(variant_url,'')), '') IS NOT NULL
    ORDER BY
      COALESCE(sort_order, 999999) ASC,
      updated_at DESC NULLS LAST,
      created_at DESC
    `,
    [serviceId]
  );

  const options = (v.rows || [])
    .map((r: any) => ({
      label: String(r.label || "Option").trim(),
      url: String(r.url || "").trim(),
    }))
    .filter((o) => o.url);

  // ✅ Si hay variantes con URL, intentamos usarla primero
  if (options.length) {
    // Si solo hay 1, listo
    if (options.length === 1) return { ok: true, url: options[0].url };

    const t = String(userText || "").trim();
    if (t) {
      // Pick por similitud label<->texto
      const scored = options
        .map((o) => ({ ...o, score: scoreLabelVsText(o.label, t) }))
        .sort((a, b) => b.score - a.score);

      const best = scored[0];
      const second = scored[1];

      // Umbrales (genéricos): debe haber match decente y no ser empate
      const strongEnough = best.score >= 0.34; // ajustable
      const clearlyBetter = !second || best.score - second.score >= 0.12;

      if (strongEnough && clearlyBetter) {
        return { ok: true, url: best.url };
      }

      return { ok: false, reason: "ambiguous", options };
    }

    // Sin userText: ambiguo
    return { ok: false, reason: "ambiguous", options };
  }

  // 3) Sin variantes -> usar service_url si existe
  if (serviceUrl) return { ok: true, url: serviceUrl };

  return { ok: false, reason: "no_link" };
}
