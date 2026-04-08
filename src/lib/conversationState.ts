// src/lib/conversationState.ts
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

// ⏱ TTL global por canal (sin tenant)
function getConversationTtlMs(canal: string) {
  const c = String(canal || "").toLowerCase();

  // Meta: conversaciones tienden a ser más espaciadas
  if (c === "facebook" || c === "instagram") return 12 * 60 * 60 * 1000; // 12h

  // WhatsApp: más rápido, pero 15 min es demasiado agresivo
  if (c === "whatsapp") return 3 * 60 * 60 * 1000; // 3h

  // Preview / otros
  return 30 * 60 * 1000; // 30 min
}

export async function getConversationState(
  tenantId: string,
  canal: string,
  senderId: string
): Promise<ConversationState | null> {
  const { rows } = await pool.query(
    `SELECT *
      FROM conversation_state
      WHERE tenant_id = $1 AND canal = $2 AND sender_id = $3
      ORDER BY updated_at DESC
      LIMIT 1`,
    [tenantId, canal, senderId]
  );

  if (!rows[0]) return null;

  const row = rows[0] as ConversationState;

  // 🧹 AUTO-RESET por inactividad (TTL)
  if (row.updated_at) {
    const last = new Date(row.updated_at).getTime();
    const now = Date.now();

    const ttlMs = getConversationTtlMs(canal);
    if (Number.isFinite(last) && now - last > ttlMs) {
      console.log("🧹 conversation_state TTL expired, clearing context:", {
        tenantId,
        canal,
        senderId,
        lastUpdated: row.updated_at,
      });

      // Mejor: resetea (no borra) para evitar "primer turno" falso
      await pool.query(
        `
        UPDATE conversation_state
          SET active_flow = NULL,
              active_step = NULL,
              context = '{}'::jsonb,
              updated_at = NOW()
        WHERE tenant_id = $1 AND canal = $2 AND sender_id = $3
        `,
        [tenantId, canal, senderId]
      );

      return null;
    }
  }

  const ctx = row.context || {};

  // limpieza defensiva de estados de pago pegados
  if (
    ctx?.estado === "esperando_pago" &&
    ctx?.intent_actual !== "pago"
  ) {
    console.log("🧹 clearing stale payment state");

    ctx.estado = null;
  }

  return {
    ...row,
    context: ctx,
  };
}

export function setConversationState(params: {
  tenantId: string;
  canal: string;
  senderId: string;
  activeFlow: string | null;
  activeStep: string | null;
  contextPatch?: Record<string, any>;
}): Promise<void>;

export function setConversationState(
  tenantId: string,
  canal: string,
  senderId: string,
  state: {
    activeFlow?: string | null;
    activeStep?: string | null;
    context?: Record<string, any>;
    contextPatch?: Record<string, any>;
  }
): Promise<void>;

export async function setConversationState(
  paramsOrTenantId:
    | {
        tenantId: string;
        canal: string;
        senderId: string;
        activeFlow: string | null;
        activeStep: string | null;
        contextPatch?: Record<string, any>;
      }
    | string,
  canalArg?: string,
  senderIdArg?: string,
  stateArg?: {
    activeFlow?: string | null;
    activeStep?: string | null;
    context?: Record<string, any>;
    contextPatch?: Record<string, any>;
  }
): Promise<void> {
  let tenantId: string;
  let canal: string;
  let senderId: string;
  let activeFlow: string | null;
  let activeStep: string | null;
  let contextPatch: Record<string, any>;

  if (typeof paramsOrTenantId === "string") {
    tenantId = paramsOrTenantId;
    canal = canalArg ?? "";
    senderId = senderIdArg ?? "";

    const state = stateArg ?? {};

    activeFlow = state.activeFlow ?? null;
    activeStep = state.activeStep ?? null;
    contextPatch =
      (state.context && typeof state.context === "object" ? state.context : null) ||
      (state.contextPatch && typeof state.contextPatch === "object"
        ? state.contextPatch
        : null) ||
      {};
  } else {
    tenantId = paramsOrTenantId.tenantId;
    canal = paramsOrTenantId.canal;
    senderId = paramsOrTenantId.senderId;
    activeFlow = paramsOrTenantId.activeFlow ?? null;
    activeStep = paramsOrTenantId.activeStep ?? null;
    contextPatch =
      paramsOrTenantId.contextPatch &&
      typeof paramsOrTenantId.contextPatch === "object"
        ? paramsOrTenantId.contextPatch
        : {};
  }

  if (!tenantId || !canal || !senderId) {
    throw new Error("setConversationState: tenantId, canal y senderId son requeridos");
  }

  const existing = await getConversationState(tenantId, canal, senderId);
  const mergedContext = {
    ...(existing?.context || {}),
    ...(contextPatch || {}),
  };

  await pool.query(
    `
    INSERT INTO conversation_state (tenant_id, canal, sender_id, active_flow, active_step, context)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (tenant_id, canal, sender_id)
    DO UPDATE SET
      active_flow = EXCLUDED.active_flow,
      active_step = EXCLUDED.active_step,
      context = EXCLUDED.context,
      updated_at = NOW()
    `,
    [tenantId, canal, senderId, activeFlow, activeStep, mergedContext]
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

  // 👇 OJO: getConversationState ya aplica TTL
  const existing = await getConversationState(tenantId, canal, senderId);

  if (existing) {
    return {
      ...existing,
      active_flow: existing.active_flow ?? defaultFlow,
      active_step: existing.active_step ?? defaultStep,
      context:
        existing.context && typeof existing.context === "object"
          ? existing.context
          : {},
    };
  }

  await setConversationState({
    tenantId,
    canal,
    senderId,
    activeFlow: defaultFlow,
    activeStep: defaultStep,
    contextPatch: {},
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