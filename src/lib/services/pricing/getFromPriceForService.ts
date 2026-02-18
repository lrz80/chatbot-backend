//src/lib/services/pricing/getFromPriceForService.ts

import type { Pool } from "pg";

export type PriceOption = {
  variantId: string;              // ✅ nuevo
  label: string;
  amount: number;
  currency: string;
  url?: string | null; // ✅
};

export type PriceInfo =
  | { ok: true; mode: "fixed"; amount: number; currency: string; service_url?: string | null }
  | {
      ok: true;
      mode: "from";
      amount: number;
      currency: string;
      options?: PriceOption[];
      optionsCount?: number;
      service_url?: string | null;
      // ✅ si luego quieres: variant_url?: string | null (lo usamos en PICK, no aquí)
    }
  | { ok: false; reason: "no_price" };

export async function getPriceInfoForService(
  pool: Pool,
  tenantId: string,
  serviceId: string
): Promise<PriceInfo> {

  // 0) Cargar service base (por si no hay variantes)
  const s = await pool.query(
    `
    SELECT
      s.price_base AS base_price,
      NULLIF(trim(s.service_url), '') AS service_url
    FROM services s
    WHERE s.tenant_id = $1
      AND s.id = $2
      AND s.active = true
    LIMIT 1
    `,
    [tenantId, serviceId]
  );

  const base = s.rows?.[0]?.base_price;
  const baseNum = Number(base);
  const serviceUrl = s.rows?.[0]?.service_url ?? null;

  // 1) ¿Hay variantes activas con precio?  (si sí, PRIORIDAD A VARIANTES)
  const vAgg = await pool.query(
    `
    SELECT
      MIN(COALESCE(v.price, s.price_base)) AS min_price,
      MAX(NULLIF(v.currency, '')) FILTER (WHERE v.currency IS NOT NULL) AS any_currency,
      COUNT(*)::int AS n,
      NULLIF(trim(MAX(s.service_url)), '') AS service_url
    FROM service_variants v
    JOIN services s ON s.id = v.service_id
    WHERE s.tenant_id = $1
      AND v.service_id = $2
      AND COALESCE(v.active, true) = true
      AND COALESCE(v.price, s.price_base) IS NOT NULL
      AND COALESCE(v.price, s.price_base) >= 0
    `,
    [tenantId, serviceId]
  );

  const n = Number(vAgg.rows?.[0]?.n || 0);
  const min = vAgg.rows?.[0]?.min_price;
  const minNum = Number(min);
  const cur = String(vAgg.rows?.[0]?.any_currency || "USD").toUpperCase();
  const serviceUrl2 = vAgg.rows?.[0]?.service_url ?? serviceUrl ?? null;

  // 2) Si hay variantes, devolvemos FROM (aunque base_price exista)
  if (n > 0 && Number.isFinite(minNum) && minNum >= 0) {
    const vList = await pool.query(
      `
      SELECT
        v.id AS variant_id,
        COALESCE(NULLIF(v.variant_name,''), 'Option') AS label,
        COALESCE(v.price, v.price_base, s.price_base)::numeric AS price,
        COALESCE(NULLIF(v.currency,''), 'USD') AS currency,
        COALESCE(NULLIF(trim(v.variant_url), ''), NULLIF(trim(s.service_url), '')) AS url
      FROM service_variants v
      JOIN services s ON s.id = v.service_id
      WHERE s.tenant_id = $1
        AND v.service_id = $2
        AND COALESCE(v.active, true) = true
        AND COALESCE(v.price, s.price_base) IS NOT NULL
        AND COALESCE(v.price, s.price_base) >= 0
      ORDER BY price ASC, v.variant_name ASC
      LIMIT 5
      `,
      [tenantId, serviceId]
    );

    const options: PriceOption[] = (vList.rows || [])
      .map((r: any) => ({
        variantId: String(r.variant_id || "").trim(), // ✅
        label: String(r.label || "").trim() || "Option",
        amount: Number(r.price),
        currency: String(r.currency || "USD").toUpperCase(),
        url: r.url ? String(r.url).trim() : null,
      }))
      .filter((o) => o.variantId && Number.isFinite(o.amount) && o.amount >= 0);

    return {
      ok: true,
      mode: "from",
      amount: minNum,
      currency: cur,
      options: options.length ? options : undefined,
      optionsCount: Number.isFinite(n) ? n : undefined,
      service_url: serviceUrl2,
    };
  }

  // 3) Si NO hay variantes, usar fixed (base_price)
  if (base !== null && base !== undefined && Number.isFinite(baseNum) && baseNum >= 0) {
    return { ok: true, mode: "fixed", amount: baseNum, currency: "USD", service_url: serviceUrl };
  }

  return { ok: false, reason: "no_price" };
}

