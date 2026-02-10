import type { Pool } from "pg";

export type PriceInfo =
  | { ok: true; mode: "fixed"; amount: number; currency: string }
  | { ok: true; mode: "from"; amount: number; currency: string }
  | { ok: false; reason: "no_price" };

export async function getPriceInfoForService(
  pool: Pool,
  tenantId: string,
  serviceId: string
): Promise<PriceInfo> {
  // 1) Precio fijo en services.price_base
  const s = await pool.query(
    `
    SELECT price_base
    FROM services
    WHERE tenant_id = $1
      AND id = $2
      AND active = true
    LIMIT 1
    `,
    [tenantId, serviceId]
  );

  const base = s.rows?.[0]?.price_base;
  const baseNum = Number(base);
  if (Number.isFinite(baseNum)) {
    return { ok: true, mode: "fixed", amount: baseNum, currency: "USD" };
  }

  // 2) “Desde” por variantes: MIN(service_variants.price)
  const v = await pool.query(
    `
    SELECT
      MIN(price) AS min_price,
      MAX(currency) FILTER (WHERE currency IS NOT NULL AND currency <> '') AS any_currency
    FROM service_variants
    WHERE tenant_id = $1
      AND service_id = $2
      AND active = true
      AND price IS NOT NULL
    `,
    [tenantId, serviceId]
  );

  const min = v.rows?.[0]?.min_price;
  const minNum = Number(min);
  if (Number.isFinite(minNum)) {
    const cur = String(v.rows?.[0]?.any_currency || "USD").toUpperCase();
    return { ok: true, mode: "from", amount: minNum, currency: cur };
  }

  return { ok: false, reason: "no_price" };
}
