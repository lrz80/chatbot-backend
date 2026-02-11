import type { Pool } from "pg";

export async function setAwaitingState(
  pool: Pool,
  opts: {
    tenantId: string;
    canal: string;
    senderId: string;
    field: string;               // ej: "yes_no", "email", "date", etc.
    payload?: any;               // info extra (kind, source, ids)
    ttlSeconds?: number;         // default 600 (10 min)
  }
) {
  const {
    tenantId,
    canal,
    senderId,
    field,
    payload = {},
    ttlSeconds = 600,
  } = opts;

  // TTL universal: si ttlSeconds <= 0, lo dejamos sin expiración (no recomendado)
  const ttl = Math.max(0, Number(ttlSeconds || 0));

  // awaiting_until: NOW() + ttlSeconds
  // Si ttl==0 => awaiting_until NULL (sin expiración)
  await pool.query(
    `
    UPDATE clientes
    SET awaiting_field = $4,
        awaiting_payload = $5::jsonb,
        awaiting_updated_at = NOW(),
        awaiting_until = CASE
          WHEN $6::int > 0 THEN NOW() + ($6::int || ' seconds')::interval
          ELSE NULL
        END,
        updated_at = NOW()
    WHERE tenant_id = $1
      AND canal = $2
      AND contacto = $3
    `,
    [tenantId, canal, senderId, field, payload, ttl]
  );
}
