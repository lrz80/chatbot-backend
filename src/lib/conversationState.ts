import pool from "./db";

export type ConversationState = {
  active_flow: string | null;
  active_step: string | null;
  context: any;
};

export async function getConversationState(params: {
  tenantId: string;
  canal: string;
  senderId: string;
}): Promise<ConversationState | null> {
  const { tenantId, canal, senderId } = params;

  const res = await pool.query(
    `SELECT active_flow, active_step, context
       FROM conversation_state
      WHERE tenant_id = $1 AND canal = $2 AND sender_id = $3
      LIMIT 1`,
    [tenantId, canal, senderId]
  );

  return res.rows[0] ?? null;
}

export async function setConversationState(params: {
  tenantId: string;
  canal: string;
  senderId: string;
  activeFlow: string | null;
  activeStep: string | null;
  context?: any;
}): Promise<void> {
  const { tenantId, canal, senderId, activeFlow, activeStep, context } = params;

  await pool.query(
    `INSERT INTO conversation_state (tenant_id, canal, sender_id, active_flow, active_step, context)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (tenant_id, canal, sender_id)
     DO UPDATE SET
       active_flow = EXCLUDED.active_flow,
       active_step = EXCLUDED.active_step,
       context = EXCLUDED.context,
       updated_at = now()`,
    [tenantId, canal, senderId, activeFlow, activeStep, JSON.stringify(context ?? {})]
  );
}

export async function clearConversationState(params: {
  tenantId: string;
  canal: string;
  senderId: string;
}): Promise<void> {
  const { tenantId, canal, senderId } = params;

  await pool.query(
    `DELETE FROM conversation_state
      WHERE tenant_id = $1 AND canal = $2 AND sender_id = $3`,
    [tenantId, canal, senderId]
  );
}
