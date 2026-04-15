// backend/src/lib/guards/yesNoStateGate.ts
import type { GateResult, TurnEvent } from "../conversation/stateMachine";

export type YesNoGateResult =
  | { action: "continue" }
  | { action: "silence"; reason: "awaiting_yesno_but_empty" }
  | {
      action: "reply";
      replySource: "yesno-clarify" | "yesno-unsupported" | "yesno-handled";
      intent: "yesno";
      facts: Record<string, any>;
      transition?: { flow?: string; step?: string; patchCtx?: any };
    }
  | {
      action: "transition";
      transition: { flow?: string; step?: string; patchCtx?: any };
    };

type YesNoResolution = "yes" | "no" | "unknown";

function normalize(text: string): string {
  return String(text || "").trim().toLowerCase();
}

function coerceYesNoResolution(value: unknown): YesNoResolution {
  if (value === "yes" || value === "no") return value;
  return "unknown";
}

function getTurnYesNoResolution(event: any): YesNoResolution {
  return coerceYesNoResolution(
    event?.yesNoResolution ??
    event?.yesnoResolution ??
    event?.resolvedYesNo ??
    null
  );
}

function getDeclaredYesNoResolution(ctx: any): YesNoResolution {
  return coerceYesNoResolution(
    ctx?.yesno_resolution ??
    ctx?.awaiting_yes_no_resolution ??
    ctx?.pending_yesno_resolution ??
    null
  );
}

function getEffectiveYesNoResolution(params: {
  event: any;
  ctx: any;
}): YesNoResolution {
  const turnResolution = getTurnYesNoResolution(params.event);
  if (turnResolution !== "unknown") {
    return turnResolution;
  }

  return getDeclaredYesNoResolution(params.ctx);
}

type LastAssistantTurnSnapshot = {
  replySourceKind?:
    | "catalog_comparison_render"
    | "catalog_grounded"
    | "catalog_disambiguation"
    | "business_info"
    | "price_like"
    | "service_detail"
    | "generic";
  answerType?:
    | "overview"
    | "direct_answer"
    | "disambiguation"
    | "comparison"
    | "guided_next_step"
    | "action_link";
  salesPosture?:
    | "inform"
    | "guide"
    | "recommend"
    | "close_soft"
    | "close_direct";
  askedQuestion?: boolean;
  closingText?: string | null;
  createdAt?: string;
};

function getLastAssistantTurnSnapshot(ctx: any): LastAssistantTurnSnapshot | null {
  if (!ctx || typeof ctx !== "object") return null;

  const value =
    ctx?.last_assistant_turn && typeof ctx.last_assistant_turn === "object"
      ? (ctx.last_assistant_turn as LastAssistantTurnSnapshot)
      : null;

  return value;
}

function isRecentAssistantTurn(value: LastAssistantTurnSnapshot | null): boolean {
  if (!value?.createdAt) return false;

  const ts = Date.parse(String(value.createdAt));
  if (!Number.isFinite(ts)) return false;

  const ageMs = Date.now() - ts;
  if (ageMs < 0) return false;

  return ageMs <= 15 * 60 * 1000;
}

function canUseSemanticYesNoContinuation(input: {
  lastAssistantTurn: LastAssistantTurnSnapshot | null;
}): boolean {
  const turn = input.lastAssistantTurn;
  if (!turn) return false;
  if (turn.askedQuestion !== true) return false;
  if (!isRecentAssistantTurn(turn)) return false;

  return true;
}

async function clearAwaitingState(params: {
  pool: any;
  tenantId: string;
  canal: string;
  senderId: string;
  awaitingKey: string;
  clearAwaiting?: ((args: {
    tenantId: string;
    canal: string;
    senderId: string;
  }) => Promise<void>) | null;
}): Promise<void> {
  const { pool, tenantId, canal, senderId, awaitingKey, clearAwaiting } = params;

  if (clearAwaiting) {
    await clearAwaiting({ tenantId, canal, senderId });
    return;
  }

  try {
    await pool.query(
      `
      UPDATE conversation_state
      SET context = COALESCE(context, '{}'::jsonb) || jsonb_build_object($4, false),
          updated_at = now()
      WHERE tenant_id = $1 AND canal = $2 AND sender_id = $3
      `,
      [tenantId, canal, senderId, awaitingKey]
    );
  } catch {
    // no bloquea
  }
}

/**
 * YES/NO Gate
 * - Lee conversation_state para saber si hay awaiting_yesno activo.
 * - No construye copy final para el usuario.
 * - Solo devuelve facts o transitions.
 * - pending_cta se resuelve como transición de estado, no como reply hardcodeado.
 */
export async function yesNoStateGate(event: TurnEvent): Promise<GateResult> {
  const {
    pool,
    tenantId,
    canal,
    senderId,
    userInput,
    idiomaDestino,
    clearAwaiting,
  } = event as any;

  const awaitingKey = "awaiting_yesno";
  const inputNorm = normalize(userInput);

  let ctx: any = null;

  try {
    const { rows } = await pool.query(
      `
      SELECT context
      FROM conversation_state
      WHERE tenant_id = $1 AND canal = $2 AND sender_id = $3
      LIMIT 1
      `,
      [tenantId, canal, senderId]
    );

    ctx = rows[0]?.context ?? null;
  } catch {
    return { action: "continue" };
  }

  const awaiting = Boolean(ctx && ctx[awaitingKey]);
  const lastAssistantTurn = getLastAssistantTurnSnapshot(ctx);
  const canUseSemanticContinuation = canUseSemanticYesNoContinuation({
    lastAssistantTurn,
  });

  if (!awaiting && !canUseSemanticContinuation) {
    return { action: "continue" };
  }

  if (!inputNorm) {
    return awaiting
      ? { action: "silence", reason: "awaiting_yesno_but_empty" }
      : { action: "continue" };
  }

  const yn = getEffectiveYesNoResolution({
    event,
    ctx,
  });

  if (yn === "unknown") {
    return {
      action: "continue",
    };
  }

  // -------------------------------------------------------------
  // Continuidad semántica genérica del último turno del asistente
  // sin depender de awaiting_yesno / pending_cta
  // -------------------------------------------------------------
  if (!awaiting && canUseSemanticContinuation) {
    return {
      action: "transition",
      transition: {
        patchCtx: {
          semantic_yesno_followup: {
            answer: yn,
            source: "last_assistant_turn",
            lastAssistantTurn,
            createdAt: new Date().toISOString(),
          },
          yesno_resolution: yn,
          last_bot_action:
            yn === "yes"
              ? "semantic_yesno_followup_accepted"
              : "semantic_yesno_followup_rejected",
          last_bot_action_at: Date.now(),
        },
      },
    };
  }

  // -------------------------------------------------------------
  // Estado declarativo para acciones yes/no
  // -------------------------------------------------------------
  const yesNoAction = ctx?.awaiting_yes_no_action ?? null;

  const isPendingCtaAction =
    Boolean(yesNoAction) &&
    typeof yesNoAction === "object" &&
    yesNoAction.kind === "pending_cta";

  const pendingCtaType =
    isPendingCtaAction && typeof yesNoAction.ctaType === "string"
      ? yesNoAction.ctaType
      : null;

  // -------------------------------------------------------------
  // pending_cta => SOLO transición, sin copy hardcodeado
  // -------------------------------------------------------------
  if (isPendingCtaAction && yn === "yes") {
    await clearAwaitingState({
      pool,
      tenantId,
      canal,
      senderId,
      awaitingKey,
      clearAwaiting,
    });

    let patchCtx: any = {
      awaiting_yes_no_action: null,
      awaiting_yesno: false,
      pending_cta: null,
      yesno_resolution: null,
    };

    if (pendingCtaType === "booking_offer") {
      patchCtx = {
        ...patchCtx,
        last_bot_action: "booking_cta_accepted",
        last_bot_action_at: Date.now(),
        booking: {
          ...(ctx?.booking || {}),
          active: true,
          step:
            ctx?.booking?.step && ctx.booking.step !== "idle"
              ? ctx.booking.step
              : "start",
        },
      };
    }

    if (pendingCtaType === "estimate_offer") {
      patchCtx = {
        ...patchCtx,
        last_bot_action: "estimate_cta_accepted",
        last_bot_action_at: Date.now(),
        estimateFlow: {
          ...(ctx?.estimateFlow || {}),
          active: true,
          step:
            ctx?.estimateFlow?.step && ctx.estimateFlow.step !== "idle"
              ? ctx.estimateFlow.step
              : "start",
        },
      };
    }

    return {
      action: "transition",
      transition: {
        patchCtx,
      },
    };
  }

  if (isPendingCtaAction && yn === "no") {
    await clearAwaitingState({
      pool,
      tenantId,
      canal,
      senderId,
      awaitingKey,
      clearAwaiting,
    });

    return {
      action: "transition",
      transition: {
        patchCtx: {
          awaiting_yes_no_action: null,
          awaiting_yesno: false,
          pending_cta: null,
          yesno_resolution: null,
          last_bot_action: "pending_cta_rejected",
          last_bot_action_at: Date.now(),
        },
      },
    };
  }

  // -------------------------------------------------------------
  // Acción declarativa genérica => facts/transition, sin copy hardcodeado
  // -------------------------------------------------------------
  if (yesNoAction && yn === "yes") {
    await clearAwaitingState({
      pool,
      tenantId,
      canal,
      senderId,
      awaitingKey,
      clearAwaiting,
    });

    return {
      action: "transition",
      transition: {
        patchCtx: {
          awaiting_yes_no_action: null,
          awaiting_yesno: false,
          yesno_resolution: null,
          last_bot_action: "yesno_accepted",
          last_bot_action_at: Date.now(),
        },
      },
    };
  }

  if (yesNoAction && yn === "no") {
    await clearAwaitingState({
      pool,
      tenantId,
      canal,
      senderId,
      awaitingKey,
      clearAwaiting,
    });

    return {
      action: "transition",
      transition: {
        patchCtx: {
          awaiting_yes_no_action: null,
          awaiting_yesno: false,
          yesno_resolution: null,
          last_bot_action: "yesno_rejected",
          last_bot_action_at: Date.now(),
        },
      },
    };
  }

  // -------------------------------------------------------------
  // Handlers declarativos on_yes / on_no
  // -------------------------------------------------------------
  const onYes = ctx?.on_yes ?? null;
  const onNo = ctx?.on_no ?? null;
  const picked = yn === "yes" ? onYes : onNo;

  await clearAwaitingState({
    pool,
    tenantId,
    canal,
    senderId,
    awaitingKey,
    clearAwaiting,
  });

  if (picked) {
    return {
      action: "transition",
      transition: {
        flow: picked.flow,
        step: picked.step,
        patchCtx: picked.patchCtx ?? { yesno_answer: yn },
      },
    };
  }

  return {
    action: "continue",
  };
}