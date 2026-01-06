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

  // ✅ GUARD: no permitir overwrite con null / undefined / "" (string vacío)
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return;
  }

  await pool.query(
    `INSERT INTO client_memory (tenant_id, canal, sender_id, "key", value)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (tenant_id, canal, sender_id, "key")
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [tenantId, canal, senderId, key, JSON.stringify(value)]
  );
}

export async function getAllMemory(params: {
  tenantId: string;
  canal: string;
  senderId: string;
}): Promise<Record<string, any>> {
  const { tenantId, canal, senderId } = params;

  const res = await pool.query(
    `SELECT "key", value
       FROM client_memory
      WHERE tenant_id = $1
        AND canal = $2
        AND sender_id = $3
      ORDER BY updated_at DESC`,
    [tenantId, canal, senderId]
  );

  // Si hay varias filas con misma key (no debería si tu ON CONFLICT está bien),
  // nos quedamos con la más reciente por el ORDER BY.
  const out: Record<string, any> = {};
  for (const row of res.rows) {
    if (out[row.key] === undefined) out[row.key] = row.value;
  }
  return out;
}

export async function setMemoryValuesBulk(params: {
  tenantId: string;
  canal: string;
  senderId: string;
  items: Array<{ key: string; value: any }>;
}): Promise<void> {
  const { tenantId, canal, senderId, items } = params;
  if (!items?.length) return;

  // Inserta/actualiza en lote usando VALUES
  const values: any[] = [];
  const placeholders: string[] = [];

  items.forEach((it, idx) => {
    const base = idx * 5;
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb)`
    );
    values.push(tenantId, canal, senderId, it.key, JSON.stringify(it.value));
  });

  await pool.query(
    `
    INSERT INTO client_memory (tenant_id, canal, sender_id, "key", value)
    VALUES ${placeholders.join(",")}
    ON CONFLICT (tenant_id, canal, sender_id, "key")
    DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `,
    values
  );
}