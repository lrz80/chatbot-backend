import pool from "./db";

export type ConversationState = {
  tenant_id: string;
  canal: string;
  sender_id: string;
  active_flow?: string | null;
  active_step?: string | null;
  context?: any;
  updated_at?: string;
  created_at?: string;
};

function getConversationTtlMs(canal: string) {
  const c = String(canal || "").toLowerCase();

  if (c === "facebook" || c === "instagram") return 12 * 60 * 60 * 1000;
  if (c === "whatsapp") return 3 * 60 * 60 * 1000;

  return 30 * 60 * 1000;
}

function buildContextAfterTtl(rawContext: any): Record<string, any> {
  const ctx =
    rawContext && typeof rawContext === "object" && !Array.isArray(rawContext)
      ? { ...rawContext }
      : {};

  // conservar anclas conversacionales útiles
  const preserved: Record<string, any> = {
    last_service_id: ctx.last_service_id ?? null,
    last_service_name: ctx.last_service_name ?? null,
    last_family_key: ctx.last_family_key ?? null,
    last_variant_id: ctx.last_variant_id ?? null,
    last_variant_name: ctx.last_variant_name ?? null,
    last_resolved_intent: ctx.last_resolved_intent ?? null,
    last_presented_entity_ids: Array.isArray(ctx.last_presented_entity_ids)
      ? ctx.last_presented_entity_ids
      : [],
    last_presented_family_keys: Array.isArray(ctx.last_presented_family_keys)
      ? ctx.last_presented_family_keys
      : [],
    last_catalog_plans: Array.isArray(ctx.last_catalog_plans)
      ? ctx.last_catalog_plans
      : [],
    last_catalog_plans_at: ctx.last_catalog_plans_at ?? null,
    structuredService:
      ctx.structuredService && typeof ctx.structuredService === "object"
        ? ctx.structuredService
        : null,
  };

  return preserved;
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

  if (row.updated_at) {
    const last = new Date(row.updated_at).getTime();
    const now = Date.now();

    const ttlMs = getConversationTtlMs(canal);

    if (Number.isFinite(last) && now - last > ttlMs) {
      const nextContext = buildContextAfterTtl(row.context);

      console.log("🧹 conversation_state TTL expired, pruning ephemeral context:", {
        tenantId,
        canal,
        senderId,
        lastUpdated: row.updated_at,
        preservedKeys: Object.keys(nextContext),
      });

      await pool.query(
        `
        UPDATE conversation_state
        SET active_flow = NULL,
            active_step = NULL,
            context = $4::jsonb,
            updated_at = NOW()
        WHERE tenant_id = $1 AND canal = $2 AND sender_id = $3
        `,
        [tenantId, canal, senderId, JSON.stringify(nextContext)]
      );

      return {
        ...row,
        active_flow: null,
        active_step: null,
        context: nextContext,
        updated_at: new Date().toISOString(),
      };
    }
  }

  const ctx =
    row.context && typeof row.context === "object" && !Array.isArray(row.context)
      ? row.context
      : {};

  if (ctx?.estado === "esperando_pago" && ctx?.intent_actual !== "pago") {
    console.log("🧹 clearing stale payment state");
    ctx.estado = null;
  }

  return {
    ...row,
    context: ctx,
  };
}

export async function setConversationState(params: {
  tenantId: string;
  canal: string;
  senderId: string;
  activeFlow: string | null;
  activeStep: string | null;
  contextPatch?: Record<string, any>;
}) {
  const { tenantId, canal, senderId, activeFlow, activeStep, contextPatch } = params;

  const existing = await getConversationState(tenantId, canal, senderId);
  const mergedContext = {
    ...(existing?.context && typeof existing.context === "object" ? existing.context : {}),
    ...(contextPatch && typeof contextPatch === "object" ? contextPatch : {}),
  };

  await pool.query(
    `
    INSERT INTO conversation_state (tenant_id, canal, sender_id, active_flow, active_step, context)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    ON CONFLICT (tenant_id, canal, sender_id)
    DO UPDATE SET
      active_flow = EXCLUDED.active_flow,
      active_step = EXCLUDED.active_step,
      context = EXCLUDED.context,
      updated_at = NOW()
    `,
    [tenantId, canal, senderId, activeFlow, activeStep, JSON.stringify(mergedContext)]
  );
}

export async function patchConversationState(params: {
  tenantId: string;
  canal: string;
  senderId: string;
  patch: any;
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
      context:
        existing.context && typeof existing.context === "object" && !Array.isArray(existing.context)
          ? existing.context
          : {},
    };
  }

  const initialContext = {};

  await setConversationState({
    tenantId,
    canal,
    senderId,
    activeFlow: defaultFlow,
    activeStep: defaultStep,
    contextPatch: initialContext,
  });

  return {
    tenant_id: tenantId,
    canal,
    sender_id: senderId,
    active_flow: defaultFlow,
    active_step: defaultStep,
    context: initialContext,
  };
}