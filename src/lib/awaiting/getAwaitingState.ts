import type { Pool } from "pg";

export type AwaitingRow = {
  awaiting_field: string | null;
  awaiting_payload: any | null;
  awaiting_updated_at: string | null;
  awaiting_until: string | null;
};

export async function getAwaitingState(
  pool: Pool,
  tenantId: string,
  canal: string,
  senderId: string
): Promise<AwaitingRow | null> {
  const { rows } = await pool.query(
    `
    SELECT awaiting_field, awaiting_payload, awaiting_updated_at, awaiting_until
    FROM clientes
    WHERE tenant_id = $1
      AND canal = $2
      AND contacto = $3
      AND awaiting_field IS NOT NULL
      AND (awaiting_until IS NULL OR awaiting_until > NOW())
    LIMIT 1
    `,
    [tenantId, canal, senderId]
  );

  return rows[0] || null;
}
