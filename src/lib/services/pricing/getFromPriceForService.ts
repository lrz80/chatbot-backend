//src/lib/services/pricing/getFromPriceForService.ts

import type { Pool } from "pg";

export type PriceOption = {
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
  // 1) Precio fijo SOLO si es válido (>0) en services.price_base
    const s = await pool.query(
      `
      SELECT s.price_base AS base_price,
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

    // ✅ Acepta 0 como precio válido (ej: clase gratis / trial / free session).
    // Solo rechazamos null/NaN o negativos.
    if (base !== null && base !== undefined && Number.isFinite(baseNum) && baseNum >= 0) {
      return { ok: true, mode: "fixed", amount: baseNum, currency: "USD", service_url: serviceUrl };
    }

  // 2) Variantes: "desde" = MIN(COALESCE(v.price, v.price_base)) + top 5 variantes
  const vAgg = await pool.query(
    `
    SELECT
      MIN(v.price) AS min_price,
      MAX(NULLIF(v.currency, '')) FILTER (WHERE v.currency IS NOT NULL) AS any_currency,
      COUNT(*)::int AS n,
      NULLIF(trim(MAX(s.service_url)), '') AS service_url
    FROM service_variants v
    JOIN services s ON s.id = v.service_id
    WHERE s.tenant_id = $1
      AND v.service_id = $2
      AND v.active = true
      AND v.price IS NOT NULL
      AND v.price > 0
    `,
    [tenantId, serviceId]
  );

  const min = vAgg.rows?.[0]?.min_price;
  const minNum = Number(min);
  const n = Number(vAgg.rows?.[0]?.n || 0);
  const serviceUrl2 = vAgg.rows?.[0]?.service_url ?? serviceUrl ?? null;

  if (Number.isFinite(minNum) && minNum > 0) {
    const vList = await pool.query(
      `
      SELECT
        COALESCE(NULLIF(v.variant_name,''), 'Option') AS label,
        v.price::numeric AS price,
        COALESCE(NULLIF(v.currency,''), 'USD') AS currency,
        NULLIF(trim(v.variant_url), '') AS variant_url
      FROM service_variants v
      JOIN services s ON s.id = v.service_id
      WHERE s.tenant_id = $1
        AND v.service_id = $2
        AND v.active = true
        AND v.price IS NOT NULL
        AND v.price > 0
        ORDER BY v.price ASC, v.variant_name ASC
      LIMIT 5
      `,
      [tenantId, serviceId]
    );

    const options: PriceOption[] = (vList.rows || [])
      .map((r: any) => ({
        label: String(r.label || "").trim() || "Option",
        amount: Number(r.price),
        currency: String(r.currency || "USD").toUpperCase(),
        url: r.variant_url ? String(r.variant_url).trim() : null,
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
      service_url: serviceUrl2,
    };
  }

  return { ok: false, reason: "no_price" };
}
