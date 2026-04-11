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
  if (!awaiting) return { action: "continue" };

  if (!inputNorm) {
    return { action: "silence", reason: "awaiting_yesno_but_empty" };
  }

  const yn = getEffectiveYesNoResolution({
    event,
    ctx,
  });

  if (yn === "unknown") {
    return {
      action: "reply",
      replySource: "yesno-clarify",
      intent: "yesno",
      facts: {
        EVENT: "YESNO_REQUIRED",
        LANGUAGE: idiomaDestino,
        QUESTION_CONTEXT: ctx?.yesno_context ?? null,
        EXPECTED_ANSWERS: ["yes", "no"],
        INSTRUCTION: "ASK_USER_TO_REPLY_YES_OR_NO_ONLY",
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
      action: "reply",
      replySource: "yesno-handled",
      intent: "yesno",
      facts: {
        EVENT: "YESNO_ACCEPTED",
        LANGUAGE: idiomaDestino,
        ACTION: yesNoAction,
      },
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
      action: "reply",
      replySource: "yesno-handled",
      intent: "yesno",
      facts: {
        EVENT: "YESNO_REJECTED",
        LANGUAGE: idiomaDestino,
        ACTION: yesNoAction,
      },
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
      action: "reply",
      replySource: "yesno-handled",
      intent: "yesno",
      facts: {
        EVENT: "YESNO_RECEIVED",
        LANGUAGE: idiomaDestino,
        ANSWER: yn,
        NEXT: picked,
      },
      transition: {
        flow: picked.flow,
        step: picked.step,
        patchCtx: picked.patchCtx ?? { yesno_answer: yn },
      },
    };
  }

  return {
    action: "reply",
    replySource: "yesno-unsupported",
    intent: "yesno",
    facts: {
      EVENT: "YESNO_RECEIVED_NO_HANDLER",
      LANGUAGE: idiomaDestino,
      ANSWER: yn,
    },
  };
}