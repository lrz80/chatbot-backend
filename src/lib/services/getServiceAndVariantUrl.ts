// src/lib/services/getServiceAndVariantUrl.ts
import type { Pool } from "pg";

export async function getServiceAndVariantUrl(
  pool: Pool,
  tenantId: string,
  serviceId: string,
  variantId?: string | null
): Promise<{ serviceUrl: string | null; variantUrl: string | null }> {
  let serviceUrl: string | null = null;
  let variantUrl: string | null = null;

  // 1) URL del servicio (service_url)
  try {
    const { rows } = await pool.query(
      `
      SELECT service_url
      FROM services
      WHERE id = $1
        AND tenant_id = $2
      LIMIT 1
      `,
      [serviceId, tenantId]
    );

    serviceUrl = rows[0]?.service_url ?? null;
  } catch (e) {
    console.warn("⚠️ getServiceAndVariantUrl: error leyendo service_url:", (e as any)?.message);
  }

  // 2) URL de la variante (variant_url), si tenemos variantId en contexto
  if (variantId) {
    try {
      const { rows } = await pool.query(
        `
        SELECT v.variant_url
        FROM service_variants v
        JOIN services s ON s.id = v.service_id
        WHERE s.tenant_id = $1
          AND v.id = $2
        LIMIT 1
        `,
        [tenantId, variantId]
      );

      variantUrl = rows[0]?.variant_url ?? null;
    } catch (e) {
      console.warn("⚠️ getServiceAndVariantUrl: error leyendo variant_url:", (e as any)?.message);
    }
  }

  return { serviceUrl, variantUrl };
}