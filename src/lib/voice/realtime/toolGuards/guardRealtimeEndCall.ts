// src/lib/voice/realtime/toolGuards/guardRealtimeEndCall.ts
import type { CallState } from "../../types";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export type RealtimeEndCallGuardResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      error:
        | "POST_BOOKING_CLOSURE_ANSWER_REQUIRED"
        | "END_CALL_BLOCKED_PENDING_BOOKING_STEP";
      message: string;
      logEvent:
        | "END_CALL_BLOCKED_WAITING_POST_SMS_REPLY"
        | "END_CALL_BLOCKED_PENDING_BOOKING_STEP";
      logPayload: Record<string, unknown>;
      responseSource:
        | "tool_guard:end_call_waiting_post_sms_reply"
        | "tool_guard:end_call_blocked_pending_booking_step";
      responseInstructions: string;
      resetLastUserDigits: boolean;
    };

function hasRealPendingBookingStep(state: CallState): boolean {
  const pendingBookingStepKey = clean(state.pendingBookingStepKey || "");
  const pendingSlot = clean((state as any).pendingBookingStepSlot || "");
  const pendingExpectedType = clean(
    (state as any).pendingBookingStepExpectedType || ""
  );
  const pendingRequired = (state as any).pendingBookingStepRequired === true;

  if (!pendingBookingStepKey) {
    return false;
  }

  return (
    pendingRequired ||
    pendingExpectedType === "confirmation" ||
    pendingExpectedType === "phone" ||
    pendingExpectedType === "datetime" ||
    pendingExpectedType === "number" ||
    (pendingExpectedType === "text" && pendingSlot !== "none")
  );
}

function shouldBlockEndCallForPendingStep(params: {
  state: CallState;
  lastUserTranscript: string;
}): boolean {
  const { state, lastUserTranscript } = params;

  if (hasRealPendingBookingStep(state)) {
    return true;
  }

  const awaitingPostBookingClosure =
    (state as any)?.awaitingPostBookingClosure === true;

  if (!awaitingPostBookingClosure) {
    return false;
  }

  const currentTranscript = clean(lastUserTranscript);

  /**
   * Si ya no hay un step real pendiente y el caller dijo algo nuevo
   * después de la pregunta final ("¿necesitas algo más?"), no bloqueamos.
   *
   * Esto evita que el flujo quede pegado cuando:
   * - pendingBookingStepKey = ""
   * - awaitingPostBookingClosure = true
   * - postBookingClosureTranscriptSeq no fue seteado
   * - el usuario dice "eso es todo", "gracias", etc.
   *
   * No dependemos de frases hardcodeadas. Solo verificamos que haya una
   * respuesta nueva del usuario.
   */
  const postBookingClosureTranscriptSeq =
    typeof (state as any)?.postBookingClosureTranscriptSeq === "number"
      ? (state as any).postBookingClosureTranscriptSeq
      : null;

  const currentTranscriptSeq =
    typeof state.lastUserTranscriptSeq === "number"
      ? state.lastUserTranscriptSeq
      : null;

  if (postBookingClosureTranscriptSeq === null) {
    return currentTranscript.length === 0;
  }

  if (currentTranscriptSeq === null) {
    return true;
  }

  return currentTranscriptSeq <= postBookingClosureTranscriptSeq;
}

export function guardRealtimeEndCall(params: {
  callSid: string | null;
  realtimeState: CallState;
  lastUserTranscript: string;
}): RealtimeEndCallGuardResult {
  const { callSid, realtimeState, lastUserTranscript } = params;

  if (
    shouldBlockEndCallForPendingStep({
      state: realtimeState,
      lastUserTranscript,
    })
  ) {
    const awaitingPostBookingClosure =
      (realtimeState as any)?.awaitingPostBookingClosure === true;

    if (awaitingPostBookingClosure) {
      return {
        ok: false,
        error: "POST_BOOKING_CLOSURE_ANSWER_REQUIRED",
        message:
          "The caller has not answered whether they need anything else after the booking.",
        logEvent: "END_CALL_BLOCKED_WAITING_POST_SMS_REPLY",
        logPayload: {
          callSid,
          awaitingPostBookingClosure: true,
          currentTranscript: clean(lastUserTranscript || ""),
          lastUserTranscriptSeq: realtimeState.lastUserTranscriptSeq,
          postBookingClosureTranscriptSeq:
            (realtimeState as any)?.postBookingClosureTranscriptSeq,
        },
        responseSource: "tool_guard:end_call_waiting_post_sms_reply",
        responseInstructions: [
          "Use only the tool result as source of truth.",
          "Do not end the call yet.",
          "The caller has not answered whether they need anything else.",
          "Ask briefly if the caller needs anything else.",
          "Ask only one question and wait for the caller answer.",
        ].join(" "),
        resetLastUserDigits: true,
      };
    }

    return {
      ok: false,
      error: "END_CALL_BLOCKED_PENDING_BOOKING_STEP",
      message:
        "The call cannot end yet because the booking flow is still waiting for the caller.",
      logEvent: "END_CALL_BLOCKED_PENDING_BOOKING_STEP",
      logPayload: {
        callSid,
        pendingBookingStepKey: clean(realtimeState.pendingBookingStepKey || ""),
        awaitingPostBookingClosure: false,
        lastUserTranscript: clean(lastUserTranscript || ""),
        lastUserTranscriptSeq: realtimeState.lastUserTranscriptSeq,
        postBookingClosureTranscriptSeq:
          (realtimeState as any)?.postBookingClosureTranscriptSeq,
      },
      responseSource: "tool_guard:end_call_blocked_pending_booking_step",
      responseInstructions: [
        "Use only the tool result as source of truth.",
        "Do not end the call yet.",
        "The booking flow is still waiting for the caller.",
        "Ask the current pending question briefly.",
        "Ask only one question and wait.",
      ].join(" "),
      resetLastUserDigits: false,
    };
  }

  return {
    ok: true,
  };
}