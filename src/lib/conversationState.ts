import pool from "./db";

export type ConversationState = {
  tenant_id: string;
  canal: string;
  sender_id: string;
  active_flow?: string | null;
  active_step?: string | null;
  context?: any; // JSON
  updated_at?: string;
  created_at?: string;
};

export async function getConversationState(
  tenantId: string,
  canal: string,
  senderId: string
): Promise<ConversationState | null> {
  const { rows } = await pool.query(
    `
    SELECT tenant_id, canal, sender_id, active_flow, active_step, context, updated_at, created_at
    FROM conversation_state
    WHERE tenant_id = $1 AND canal = $2 AND sender_id = $3
    LIMIT 1
    `,
    [tenantId, canal, senderId]
  );

  return rows[0] || null;
}

export async function setConversationState(params: {
  tenantId: string;
  canal: string;
  senderId: string;
  activeFlow?: string | null;
  activeStep?: string | null;
  context?: any; // JSON
}): Promise<void> {
  const { tenantId, canal, senderId, activeFlow = null, activeStep = null, context = {} } = params;

  await pool.query(
    `
    INSERT INTO conversation_state (tenant_id, canal, sender_id, active_flow, active_step, context, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
    ON CONFLICT (tenant_id, canal, sender_id)
    DO UPDATE SET
      active_flow = EXCLUDED.active_flow,
      active_step = EXCLUDED.active_step,
      context = EXCLUDED.context,
      updated_at = NOW()
    `,
    [tenantId, canal, senderId, activeFlow, activeStep, JSON.stringify(context ?? {})]
  );
}

export async function patchConversationState(params: {
  tenantId: string;
  canal: string;
  senderId: string;
  patch: any; // se mergea en context
}): Promise<void> {
  const { tenantId, canal, senderId, patch } = params;

  await pool.query(
    `
    INSERT INTO conversation_state (tenant_id, canal, sender_id, context, updated_at)
    VALUES ($1, $2, $3, $4::jsonb, NOW())
    ON CONFLICT (tenant_id, canal, sender_id)
    DO UPDATE SET
      context = COALESCE(conversation_state.context, '{}'::jsonb) || EXCLUDED.context,
      updated_at = NOW()
    `,
    [tenantId, canal, senderId, JSON.stringify(patch ?? {})]
  );
}

export async function clearConversationState(
  tenantId: string,
  canal: string,
  senderId: string
): Promise<void> {
  await pool.query(
    `
    DELETE FROM conversation_state
    WHERE tenant_id = $1 AND canal = $2 AND sender_id = $3
    `,
    [tenantId, canal, senderId]
  );
}
