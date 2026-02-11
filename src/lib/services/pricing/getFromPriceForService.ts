//src/lib/services/pricing/getFromPriceForService.ts

import type { Pool } from "pg";

export type PriceOption = {
  label: string;
  amount: number;
  currency: string;
};

export type PriceInfo =
  | { ok: true; mode: "fixed"; amount: number; currency: string }
  | {
      ok: true;
      mode: "from";
      amount: number;
      currency: string;
      options?: PriceOption[];
      optionsCount?: number;
    }
  | { ok: false; reason: "no_price" };

export async function getPriceInfoForService(
  pool: Pool,
  tenantId: string,
  serviceId: string
): Promise<PriceInfo> {
  // 1) Precio fijo SOLO si es válido (>0) en services.price_base
    const s = await pool.query(
    `
    SELECT s.price_base AS base_price
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

    // ⚠️ Importante: si price_base está en 0 o null, NO lo uses.
    if (Number.isFinite(baseNum) && baseNum > 0) {
    return { ok: true, mode: "fixed", amount: baseNum, currency: "USD" };
    }

  // 2) Variantes: "desde" = MIN(COALESCE(v.price, v.price_base)) + top 5 variantes
  const vAgg = await pool.query(
    `
    SELECT
      MIN(COALESCE(v.price, v.price_base)) AS min_price,
      MAX(NULLIF(v.currency, '')) FILTER (WHERE v.currency IS NOT NULL) AS any_currency,
      COUNT(*)::int AS n
    FROM service_variants v
    JOIN services s ON s.id = v.service_id
    WHERE s.tenant_id = $1
      AND v.service_id = $2
      AND v.active = true
      AND COALESCE(v.price, v.price_base) IS NOT NULL
      AND COALESCE(v.price, v.price_base) > 0
    `,
    [tenantId, serviceId]
  );

  const min = vAgg.rows?.[0]?.min_price;
  const minNum = Number(min);
  const n = Number(vAgg.rows?.[0]?.n || 0);

  if (Number.isFinite(minNum) && minNum > 0) {
    const vList = await pool.query(
      `
      SELECT
        COALESCE(NULLIF(v.variant_name,''), 'Option') AS label,
        COALESCE(v.price, v.price_base)::numeric AS price,
        COALESCE(NULLIF(v.currency,''), 'USD') AS currency
      FROM service_variants v
      JOIN services s ON s.id = v.service_id
      WHERE s.tenant_id = $1
        AND v.service_id = $2
        AND v.active = true
        AND COALESCE(v.price, v.price_base) IS NOT NULL
        AND COALESCE(v.price, v.price_base) > 0
      ORDER BY COALESCE(v.price, v.price_base) ASC, v.variant_name ASC
      LIMIT 5
      `,
      [tenantId, serviceId]
    );

    const options: PriceOption[] = (vList.rows || [])
      .map((r: any) => ({
        label: String(r.label || "").trim() || "Option",
        amount: Number(r.price),
        currency: String(r.currency || "USD").toUpperCase(),
      }))
      .filter((o) => Number.isFinite(o.amount) && o.amount > 0);

    const cur = String(vAgg.rows?.[0]?.any_currency || "USD").toUpperCase();

    return {
      ok: true,
      mode: "from",
      amount: minNum,
      currency: cur,
      options: options.length ? options : undefined,
      optionsCount: Number.isFinite(n) ? n : undefined,
    };
  }

  return { ok: false, reason: "no_price" };
}
