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

export async function setConversationState(
  tenantId: string,
  canal: string,
  senderId: string,
  state: { activeFlow?: string | null; activeStep?: string | null; context?: any }
) {
  await pool.query(
    `
    INSERT INTO conversation_state (tenant_id, canal, sender_id, active_flow, active_step, context, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (tenant_id, canal, sender_id)
    DO UPDATE SET
      active_flow = COALESCE(EXCLUDED.active_flow, conversation_state.active_flow),
      active_step = COALESCE(EXCLUDED.active_step, conversation_state.active_step),
      context = EXCLUDED.context,
      updated_at = NOW()
    `,
    [
      tenantId,
      canal,
      senderId,
      state.activeFlow ?? null,
      state.activeStep ?? null,
      state.context ?? null,
    ]
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

export async function getOrInitConversationState(params: {
  tenantId: string;
  canal: string;
  senderId: string;
  defaultFlow?: string;
  defaultStep?: string;
}): Promise<ConversationState> {
  const { tenantId, canal, senderId } = params;
  const defaultFlow = params.defaultFlow ?? "generic_sales";
  const defaultStep = params.defaultStep ?? "start";

  const existing = await getConversationState(tenantId, canal, senderId);

  if (existing) {
    return {
      ...existing,
      active_flow: existing.active_flow ?? defaultFlow,
      active_step: existing.active_step ?? defaultStep,
      context: (existing.context && typeof existing.context === "object") ? existing.context : {},
    };
  }

  await setConversationState(tenantId, canal, senderId, {
    activeFlow: defaultFlow,
    activeStep: defaultStep,
    context: {},
  });

  // re-lee para devolver consistente
  const created = await getConversationState(tenantId, canal, senderId);
  return {
    ...(created as ConversationState),
    active_flow: defaultFlow,
    active_step: defaultStep,
    context: {},
  };
}
