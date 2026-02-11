import type { Pool } from "pg";

export async function clearAwaitingState(
  pool: Pool,
  tenantId: string,
  canal: string,
  senderId: string
) {
  await pool.query(
    `
    UPDATE clientes
    SET awaiting_field = NULL,
        awaiting_payload = NULL,
        awaiting_updated_at = NULL,
        awaiting_until = NULL,
        updated_at = NOW()
    WHERE tenant_id = $1
      AND canal = $2
      AND contacto = $3
    `,
    [tenantId, canal, senderId]
  );
}
