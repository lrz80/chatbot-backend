import type { Pool } from "pg";

function extractFirstUrl(text: string): string | null {
  const t = String(text || "");
  const m = t.match(/https?:\/\/[^\s)>\]]+/i);
  if (!m) return null;
  // limpia trailing punctuations comunes
  return m[0].replace(/[),.;!?]+$/g, "");
}

export async function getTenantFallbackLink(pool: Pool, tenantId: string): Promise<string | null> {
  // Ajusta columnas si tu tabla tenants tiene otros nombres
  const { rows } = await pool.query(
    `
    SELECT
      COALESCE(info_clave, '') AS info_clave,
      COALESCE(funciones_asistente, '') AS funciones_asistente,
      COALESCE(prompt, '') AS prompt,
      COALESCE(prompt_meta, '') AS prompt_meta
    FROM tenants
    WHERE id = $1
    LIMIT 1
    `,
    [tenantId]
  );

  const r = rows?.[0];
  if (!r) return null;

  // prioridad: info_clave -> funciones -> prompt -> prompt_meta
  return (
    extractFirstUrl(r.info_clave) ||
    extractFirstUrl(r.funciones_asistente) ||
    extractFirstUrl(r.prompt) ||
    extractFirstUrl(r.prompt_meta) ||
    null
  );
}
