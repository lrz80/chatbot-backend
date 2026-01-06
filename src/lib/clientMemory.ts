import pool from "./db";

export async function getMemoryValue<T = any>(params: {
  tenantId: string;
  canal: string;
  senderId: string;
  key: string;
}): Promise<T | null> {
  const { tenantId, canal, senderId, key } = params;

  const res = await pool.query(
    `SELECT value
       FROM client_memory
      WHERE tenant_id = $1
        AND canal = $2
        AND sender_id = $3
        AND "key" = $4
      LIMIT 1`,
    [tenantId, canal, senderId, key]
  );

  return res.rows[0]?.value ?? null;
}

export async function setMemoryValue(params: {
  tenantId: string;
  canal: string;
  senderId: string;
  key: string;
  value: any;
}): Promise<void> {
  const { tenantId, canal, senderId, key, value } = params;

  await pool.query(
    `INSERT INTO client_memory (tenant_id, canal, sender_id, "key", value)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (tenant_id, canal, sender_id, "key")
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [tenantId, canal, senderId, key, JSON.stringify(value)]
  );
}
