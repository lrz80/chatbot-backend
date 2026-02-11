import type { Pool } from "pg";

export type ResolvedService = { id: string; name: string; score: number } | null;

export async function resolveServiceByText(
  pool: Pool,
  tenantId: string,
  text: string,
  opts?: { minScore?: number }
): Promise<ResolvedService> {
  const q = `
    SELECT
      id,
      name,
      similarity(lower(name), lower($2)) AS score
    FROM services
    WHERE tenant_id = $1
      AND active = true
    ORDER BY score DESC
    LIMIT 5
  `;

  const { rows } = await pool.query(q, [tenantId, text]);
  if (!rows?.length) return null;

  const best = rows[0];
  const score = Number(best.score || 0);
  const minScore = opts?.minScore ?? 0.33;

  if (score >= minScore) {
    return { id: String(best.id), name: String(best.name), score };
  }

  // fallback ILIKE si similarity no alcanza (pero hay match parcial)
  const q2 = `
    SELECT id, name, 0::float AS score
    FROM services
    WHERE tenant_id = $1
      AND active = true
      AND lower(name) LIKE '%' || lower($2) || '%'
    ORDER BY name ASC
    LIMIT 1
  `;
  const r2 = await pool.query(q2, [tenantId, text]);
  if (r2.rows?.[0]) return { id: String(r2.rows[0].id), name: String(r2.rows[0].name), score: 0 };

  return null;
}
