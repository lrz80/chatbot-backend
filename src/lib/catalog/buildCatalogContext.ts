// backend/src/lib/catalog/buildCatalogContext.ts
import type { Pool } from "pg";

/**
 * Construye un texto de catálogo a partir de:
 *  - services
 *  - service_variants
 * para un tenant.
 *
 * No hay nada hardcodeado por negocio; todo sale de la DB.
 */
export async function buildCatalogContext(pool: Pool, tenantId: string) {
  // 1) Servicios / planes base
  const { rows: services } = await pool.query(
    `
    SELECT
      id,
      name,
      description,
      category,
      duration_min,
      price_base,
      service_url,
      tipo,
      parent_service_id
    FROM services
    WHERE tenant_id = $1
      AND active = true
    ORDER BY
      tipo NULLS LAST,
      category NULLS LAST,
      price_base NULLS LAST,
      name
    `,
    [tenantId]
  );

  // 2) Variantes (packs, tamaños, autopay, etc.)
  const { rows: variants } = await pool.query(
    `
    SELECT
      v.id,
      v.service_id,
      v.variant_name,
      v.description,
      v.duration_min,
      v.price,
      v.currency,
      v.variant_url,
      v.size_token,
      v.min_weight_lbs,
      v.max_weight_lbs
    FROM service_variants v
    JOIN services s ON s.id = v.service_id
    WHERE s.tenant_id = $1
      AND v.active = true
    ORDER BY
      v.price NULLS LAST,
      v.variant_name
    `,
    [tenantId]
  );

  // 3) Agrupar variantes por servicio
  const variantsByService: Record<string, any[]> = {};
  for (const v of variants) {
    const key = String(v.service_id);
    if (!variantsByService[key]) variantsByService[key] = [];
    variantsByService[key].push(v);
  }

  // 4) Generar texto de catálogo neutro (sin nada específico de Synergy)
  let text = "CATALOGO DE SERVICIOS Y PLANES\n\n";

  for (const s of services) {
    const svcId = String(s.id);
    const svcVariants = variantsByService[svcId] ?? [];

    text += `SERVICIO/PLAN: ${s.name}\n`;

    if (s.tipo) text += `Tipo: ${s.tipo}\n`;                 // ej: "plan", "clase", "membresia"
    if (s.category) text += `Categoría: ${s.category}\n`;    // ej: "indoor_cycling", "functional", "addon"
    if (s.description) text += `Descripción: ${s.description}\n`;
    if (s.duration_min != null) text += `Duración: ${s.duration_min} minutos\n`;
    if (s.price_base != null) text += `Precio base: ${s.price_base}\n`;
    if (s.service_url) text += `URL: ${s.service_url}\n`;

    if (svcVariants.length > 0) {
      text += `Variantes / opciones:\n`;
      for (const v of svcVariants) {
        let line = `- ${v.variant_name}`;

        if (v.price != null) {
          line += ` — ${v.price}`;
          if (v.currency) line += ` ${v.currency}`;
        }

        const details: string[] = [];
        if (v.description) details.push(v.description);
        if (v.duration_min != null) details.push(`duración ${v.duration_min} min`);
        if (v.size_token) details.push(`tamaño ${v.size_token}`);
        if (v.min_weight_lbs != null || v.max_weight_lbs != null) {
          const from = v.min_weight_lbs != null ? `${v.min_weight_lbs}` : "";
          const to = v.max_weight_lbs != null ? `${v.max_weight_lbs}` : "";
          details.push(`peso ${from}${from && to ? "-" : ""}${to} lbs`);
        }

        if (details.length) line += ` (${details.join(", ")})`;
        if (v.variant_url) line += ` — URL: ${v.variant_url}`;

        text += line + "\n";
      }
    }

    text += "\n";
  }

  return text.trim();
}