// src/lib/faq/fetchFaqPrecio.ts
import pool from '../db';

/**
 * Busca la FAQ de precios de forma robusta:
 * - Coincidencias exactas con alias comunes (precio, precios, tarifas, etc.)
 * - Sub-slugs que empiezan por "precio" (p.ej. "precio_cycling")
 * Devuelve la respuesta o null si no hay coincidencia.
 */
export async function fetchFaqPrecio(
  tenantId: string,
  canal: string
): Promise<string | null> {
  const alias = [
    'precio','precios','tarifas','costos','planes','plan',
    'membresia','membership','pricing','prices'
  ];

  const { rows } = await pool.query(
    `
    SELECT respuesta, intencion
    FROM faqs
    WHERE tenant_id = $1
      AND canal = $2
      AND (
        LOWER(intencion) = ANY($3::text[])
        OR LOWER(intencion) LIKE 'precio%'   -- sub-slugs tipo "precio_cycling"
      )
    ORDER BY
      CASE
        WHEN LOWER(intencion) = 'precio'  THEN 0
        WHEN LOWER(intencion) = 'precios' THEN 1
        WHEN LOWER(intencion) = 'tarifas' THEN 2
        WHEN LOWER(intencion) = 'costos'  THEN 3
        WHEN LOWER(intencion) = 'planes'  THEN 4
        WHEN LOWER(intencion) = 'plan'    THEN 5
        WHEN LOWER(intencion) LIKE 'precio%' THEN 6
        ELSE 7
      END
    LIMIT 1
    `,
    [tenantId, canal, alias]
  );

  return rows[0]?.respuesta ?? null;
}
