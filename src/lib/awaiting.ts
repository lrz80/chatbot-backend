// backend/src/lib/awaiting.ts
import pool from "./db";

export type AwaitingStateRow = {
  awaiting_field: string | null;
  awaiting_payload: any | null;
  awaiting_updated_at: Date | null;
};

const AWAITING_TTL_MIN = 45;

function isExpired(dt: Date | null) {
  if (!dt) return true;
  const ageMs = Date.now() - new Date(dt).getTime();
  return ageMs > AWAITING_TTL_MIN * 60 * 1000;
}

export async function getAwaitingState(
  tenantId: string,
  canal: string,
  contacto: string
): Promise<AwaitingStateRow | null> {
  const { rows } = await pool.query(
    `
    SELECT awaiting_field, awaiting_payload, awaiting_updated_at
    FROM clientes
    WHERE tenant_id = $1 AND canal = $2 AND contacto = $3
    LIMIT 1
    `,
    [tenantId, canal, contacto]
  );

  const row: AwaitingStateRow | undefined = rows[0];
  if (!row?.awaiting_field) return null;

  // TTL: si expiró, lo limpiamos y devolvemos null
  if (isExpired(row.awaiting_updated_at ? new Date(row.awaiting_updated_at) : null)) {
    await pool.query(
      `
      UPDATE clientes
      SET awaiting_field = NULL,
          awaiting_payload = '{}'::jsonb,
          awaiting_updated_at = NULL,
          updated_at = NOW()
      WHERE tenant_id = $1 AND canal = $2 AND contacto = $3
      `,
      [tenantId, canal, contacto]
    );
    return null;
  }

  return row;
}

export async function setAwaitingState(
  tenantId: string,
  canal: string,
  contacto: string,
  awaitingField: string | null,
  awaitingPayload: any = {}
): Promise<void> {
  await pool.query(
    `
    INSERT INTO clientes (tenant_id, canal, contacto, awaiting_field, awaiting_payload, awaiting_updated_at, updated_at)
    VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW())
    ON CONFLICT (tenant_id, canal, contacto)
    DO UPDATE SET
      awaiting_field = EXCLUDED.awaiting_field,
      awaiting_payload = EXCLUDED.awaiting_payload,
      awaiting_updated_at = NOW(),
      updated_at = NOW()
    `,
    [tenantId, canal, contacto, awaitingField, JSON.stringify(awaitingPayload ?? {})]
  );
}
