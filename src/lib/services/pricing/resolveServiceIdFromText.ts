import type { Pool } from "pg";

export async function resolveServiceIdFromText(
  pool: Pool,
  tenantId: string,
  userText: string
): Promise<{ id: string; name: string } | null> {
  const t = String(userText || "").trim().toLowerCase();
  if (!t) return null;

  // 1) Intento por match simple (ILIKE)
  const { rows } = await pool.query(
    `
    SELECT id, name
    FROM services
    WHERE tenant_id = $1
      AND active = true
      AND (
        LOWER($2) LIKE '%' || LOWER(name) || '%'
        OR LOWER(name) LIKE '%' || LOWER($2) || '%'
      )
    ORDER BY LENGTH(name) DESC
    LIMIT 1
    `,
    [tenantId, t]
  );

  return rows?.[0] || null;
}
