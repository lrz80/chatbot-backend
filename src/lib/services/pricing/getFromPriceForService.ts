import type { Pool } from "pg";

export type PriceInfo =
  | { ok: true; mode: "fixed"; amount: number; currency: string }
  | { ok: true; mode: "from"; amount: number; currency: string }
  | { ok: false; reason: "no_price" };

function toValidAmount(x: any): number | null {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  return n;
}

export async function getPriceInfoForService(
  pool: Pool,
  tenantId: string,
  serviceId: string
): Promise<PriceInfo> {
  if (!tenantId || !serviceId) return { ok: false, reason: "no_price" };

  // 1) Primero: si existen variantes con precio, SIEMPRE manda variantes (desde)
  const v = await pool.query(
    `
    SELECT
      MIN(v.price) AS min_price,
      MAX(v.currency) FILTER (WHERE v.currency IS NOT NULL AND v.currency <> '') AS any_currency,
      COUNT(*) AS n
    FROM service_variants v
    WHERE v.tenant_id = $1
      AND v.service_id = $2
      AND v.active = true
      AND v.price IS NOT NULL
      AND v.price > 0
    `,
    [tenantId, serviceId]
  );

  const nVariants = Number(v.rows?.[0]?.n || 0);
  const minNum = toValidAmount(v.rows?.[0]?.min_price);

  if (nVariants > 0 && minNum !== null) {
    const cur = String(v.rows?.[0]?.any_currency || "USD").toUpperCase();
    return { ok: true, mode: "from", amount: minNum, currency: cur };
  }

  // 2) Si NO hay variantes con precio: usa price_base del service (fijo)
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

  const baseNum = toValidAmount(s.rows?.[0]?.price_base);
  if (baseNum !== null) {
    return { ok: true, mode: "fixed", amount: baseNum, currency: "USD" };
  }

  return { ok: false, reason: "no_price" };
}
