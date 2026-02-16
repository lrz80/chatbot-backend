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

// match “autopay / monthly / por mes” sin hardcode de negocio
function wantsAutopayOrMonthly(userText: string) {
  const t = norm(userText);
  const wantsAutopay = /\b(autopay|auto\s*pay|automatico|automático|renovacion|renovación)\b/.test(t);
  const wantsMonthly = /\b(por\s+mes|mensual|monthly|per\s+month)\b/.test(t);
  return { wantsAutopay, wantsMonthly };
}

export async function resolveBestLinkForService(args: {
  pool: Pool;
  tenantId: string;
  serviceId: string;
  userText?: string | null;
}): Promise<LinkPick> {
  const { pool, tenantId, serviceId, userText } = args;

  // 1) service_url
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
  if (serviceUrl) return { ok: true, url: serviceUrl };

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

  if (!options.length) return { ok: false, reason: "no_link" };

  // Si solo hay 1 URL, listo
  if (options.length === 1) return { ok: true, url: options[0].url };

  // Intentar elegir por texto del usuario (autopay / mensual)
  const t = norm(userText || "");
  const { wantsAutopay, wantsMonthly } = wantsAutopayOrMonthly(t);

  const pickByKeyword = () => {
    if (wantsAutopay) {
      const hit = options.find((o) => /\bautopay\b/.test(norm(o.label)));
      if (hit) return hit;
    }
    if (wantsMonthly) {
      const hit = options.find((o) => /\b(por\s+mes|mensual|monthly|per\s+month)\b/.test(norm(o.label)));
      if (hit) return hit;
    }
    // fallback: match substring label
    const hit = options.find((o) => t && norm(o.label).includes(t));
    return hit || null;
  };

  const picked = pickByKeyword();
  if (picked) return { ok: true, url: picked.url };

  return { ok: false, reason: "ambiguous", options };
}
