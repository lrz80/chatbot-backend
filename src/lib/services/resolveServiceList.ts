import pool from "../db";

export type ServiceListItem = {
  service_id: string;
  name: string;
  category: string | null;
  duration_min: number | null;
  price_base: number | null;
  service_url: string | null;
  variants: {
    variant_id: string;
    variant_name: string;
    price: number | null;
    duration_min: number | null;
    variant_url: string | null;
  }[];
};

export async function resolveServiceList(opts: {
  tenantId: string;
  limitServices?: number;
  limitVariantsPerService?: number;
}): Promise<{ ok: true; items: ServiceListItem[] } | { ok: false; reason: "empty" | "error" }> {
  const tenantId = opts.tenantId;
  const limitServices = Math.min(20, Math.max(1, opts.limitServices ?? 8));
  const limitVariantsPerService = Math.min(5, Math.max(0, opts.limitVariantsPerService ?? 3));

  try {
    // 1) SOLO servicios reales (tipo='service')
    const sRes = await pool.query(
      `
      SELECT id, name, category, duration_min, price_base, service_url
      FROM services
      WHERE tenant_id = $1
        AND active = TRUE
        AND COALESCE(tipo, 'service') = 'service'
      ORDER BY updated_at DESC
      LIMIT $2
      `,
      [tenantId, limitServices]
    );

    const services = sRes.rows || [];
    if (!services.length) return { ok: false, reason: "empty" };

    // 2) variantes (máx N por servicio)
    const ids = services.map((s: any) => s.id);
    const variantsByService: Record<string, any[]> = {};

    if (limitVariantsPerService > 0) {
      const vRes = await pool.query(
        `
        SELECT id, service_id, variant_name, price, duration_min, variant_url
        FROM service_variants
        WHERE service_id = ANY($1::uuid[])
          AND active = TRUE
        ORDER BY updated_at DESC
        `,
        [ids]
      );

      for (const v of (vRes.rows || [])) {
        const sid = String(v.service_id);
        variantsByService[sid] = variantsByService[sid] || [];
        if (variantsByService[sid].length < limitVariantsPerService) {
          variantsByService[sid].push(v);
        }
      }
    }

    const items: ServiceListItem[] = services.map((s: any) => ({
      service_id: String(s.id),
      name: String(s.name),
      category: s.category ? String(s.category) : null,
      duration_min: (s.duration_min === null || s.duration_min === undefined) ? null : Number(s.duration_min),
      price_base: (s.price_base === null || s.price_base === undefined) ? null : Number(s.price_base),
      service_url: s.service_url ? String(s.service_url) : null,
      variants: (variantsByService[String(s.id)] || []).map((v: any) => ({
        variant_id: String(v.id),
        variant_name: String(v.variant_name),
        price: (v.price === null || v.price === undefined) ? null : Number(v.price),
        duration_min: (v.duration_min === null || v.duration_min === undefined) ? null : Number(v.duration_min),
        variant_url: v.variant_url ? String(v.variant_url) : null,
      })),
    }));

    return { ok: true, items };
  } catch (e) {
    console.warn("resolveServiceList failed:", e);
    return { ok: false, reason: "error" };
  }
}
