//src/lib/services/buildPricingSnapshot.ts
import type { Pool } from "pg";

export async function buildPricingSnapshot(pool: Pool, tenantId: string): Promise<string> {
  // 1) Traer servicios + variantes
  const { rows } = await pool.query(
    `
    SELECT
      s.id,
      s.name,
      s.category,
      s.tipo,
      s.price_base::numeric as base_price,
      v.id as variant_id,
      v.variant_name,
      v.price::numeric as variant_price
    FROM services s
    LEFT JOIN service_variants v ON v.service_id = s.id AND COALESCE(v.active, true) = true
    WHERE
      s.tenant_id = $1
      AND s.active = true
    ORDER BY
      COALESCE(s.category, ''), s.name, v.price
    `,
    [tenantId]
  );

  // 2) Agrupar por servicio
  type ServiceAgg = {
    name: string;
    category: string | null;
    tipo: string | null;
    basePrice: number | null;
    variants: { name: string; price: number }[];
  };

  const byService = new Map<string, ServiceAgg>();

  for (const r of rows) {
    const sid = String(r.id);
    if (!byService.has(sid)) {
      byService.set(sid, {
        name: String(r.name || "").trim(),
        category: r.category ? String(r.category).trim() : null,
        tipo: r.tipo ? String(r.tipo).trim() : null,
        basePrice: r.base_price != null ? Number(r.base_price) : null,
        variants: [],
      });
    }

    const svc = byService.get(sid)!;

    if (r.variant_id && r.variant_price != null) {
      svc.variants.push({
        name: (r.variant_name ? String(r.variant_name) : "").trim(),
        price: Number(r.variant_price),
      });
    }
  }

  // 3) Renderizar a texto plano (genérico, sin negocio hardcode)
  const lines: string[] = [];
  lines.push("SERVICIOS Y PRECIOS (extraídos del sistema):");

  for (const svc of byService.values()) {
    const label = svc.name;

    if (svc.variants.length) {
      // Si hay variantes, mostramos rango + detalle
      const prices = svc.variants.map(v => v.price).filter(n => n > 0);
      const min = Math.min(...prices);
      const max = Math.max(...prices);

      if (min === max) {
        lines.push(`- ${label}: $${min.toFixed(2)} (una sola variante)`);
      } else {
        lines.push(`- ${label}: desde $${min.toFixed(2)} hasta $${max.toFixed(2)}`);
      }

      for (const v of svc.variants) {
        const vn = v.name || "";
        lines.push(`   • ${vn}: $${v.price.toFixed(2)}`);
      }
    } else if (svc.basePrice != null) {
      const p = svc.basePrice;
      if (p <= 0) {
        lines.push(`- ${label}: $0 (gratis)`);
      } else {
        lines.push(`- ${label}: $${p.toFixed(2)}`);
      }
    } else {
      // sin precio cargado -> lo marcamos, pero sin inventar
      lines.push(`- ${label}: (precio no cargado en el sistema)`);
    }
  }

  return lines.join("\n");
}