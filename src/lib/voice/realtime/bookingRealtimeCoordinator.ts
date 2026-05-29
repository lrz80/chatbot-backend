//src/lib/voice/realtime/bookingRealtimeCoordinator.ts
import type { CallState } from "../types";
import {
  canFlushDeferredSubmitBookingStep,
  getRealtimeToolName,
  parseRealtimeToolArgs,
  shouldDeferSubmitBookingStepUntilTranscript,
  type DeferredSubmitBookingStepState,
} from "./deferredSubmitBookingStep";

type RequestRealtimeResponse = (
  response?: Record<string, unknown>,
  source?: string
) => void;

type BookingRealtimeCoordinatorParams = {
  getCallSid: () => string | null;
  getRealtimeState: () => CallState;
  getLastUserTranscript: () => string;
  getLastUserTranscriptSeq: () => number;
  enqueueRealtimeToolCall: (event: any) => void;
  requestRealtimeResponse: RequestRealtimeResponse;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function getPendingBookingStepKey(realtimeState: CallState): string {
  return clean((realtimeState as any).pendingBookingStepKey);
}

function getBookingTurnStatus(realtimeState: CallState): string {
  return clean((realtimeState as any).bookingTurnStatus);
}

function getPendingBookingStepPromptAnchorSeq(realtimeState: CallState): number {
  return typeof (realtimeState as any).pendingBookingStepPromptAnchorSeq ===
    "number"
    ? (realtimeState as any).pendingBookingStepPromptAnchorSeq
    : -1;
}

function getDeferredSubmittedStepKey(
  deferredSubmitBookingStep: DeferredSubmitBookingStepState
): string {
  if (!deferredSubmitBookingStep.event) return "";
  const args = parseRealtimeToolArgs(deferredSubmitBookingStep.event);
  return clean(args.step_key);
}

export function createBookingRealtimeCoordinator(
  params: BookingRealtimeCoordinatorParams
) {
  let lastBookingTranscriptNudgeSeq = 0;
  let lastBookingEarlyAnswerCatchupKey = "";

  let deferredSubmitBookingStep: DeferredSubmitBookingStepState = {
    event: null,
    reason: null,
  };

  function reset(): void {
    lastBookingTranscriptNudgeSeq = 0;
    lastBookingEarlyAnswerCatchupKey = "";
    deferredSubmitBookingStep = {
      event: null,
      reason: null,
    };
  }

  function hasDeferredSubmitBookingStep(): boolean {
    return Boolean(deferredSubmitBookingStep.event);
  }

  function clearStaleDeferredSubmitIfItCannotApplyToCurrentTurn(paramsForLog: {
    source: string;
    pendingBookingStepKey: string;
    lastUserTranscript: string;
    lastUserTranscriptSeq: number;
    pendingBookingStepPromptAnchorSeq: number;
  }): boolean {
    if (!deferredSubmitBookingStep.event) return false;

    const realtimeState = params.getRealtimeState();
    const submittedStepKey = getDeferredSubmittedStepKey(
      deferredSubmitBookingStep
    );

    const pendingStepKey = paramsForLog.pendingBookingStepKey;
    const bookingTurnStatus = getBookingTurnStatus(realtimeState);

    const check = canFlushDeferredSubmitBookingStep({
      event: deferredSubmitBookingStep.event,
      realtimeState,
      lastUserTranscript: paramsForLog.lastUserTranscript,
      lastUserTranscriptSeq: paramsForLog.lastUserTranscriptSeq,
    });

    if (check.ok) {
      return false;
    }

    const isSameStep = submittedStepKey && submittedStepKey === pendingStepKey;

    const callerAlreadyAnsweredAfterPrompt =
      paramsForLog.lastUserTranscriptSeq >
      paramsForLog.pendingBookingStepPromptAnchorSeq;

    /**
     * Important:
     * A deferred submit is only useful while it can still apply to the current
     * booking turn. If the caller already produced a newer transcript for the
     * same pending step, keeping the old deferred submit blocks the fresh answer.
     *
     * This is what caused cases like:
     * - service ambiguity prompt is opened
     * - caller answers "dos semanas refill"
     * - coordinator skips the transcript nudge because an old deferred submit is still pending
     */
    const shouldClearStaleDeferred =
      bookingTurnStatus === "waiting_user_answer" &&
      isSameStep &&
      callerAlreadyAnsweredAfterPrompt;

    if (!shouldClearStaleDeferred) {
      return false;
    }

    console.warn("[VOICE_REALTIME][DEFERRED_SUBMIT_BOOKING_STEP_CLEARED_STALE]", {
      callSid: params.getCallSid(),
      source: paramsForLog.source,
      deferredReason: deferredSubmitBookingStep.reason,
      submittedStepKey,
      pendingStepKey,
      bookingTurnStatus,
      lastUserTranscript: paramsForLog.lastUserTranscript,
      lastUserTranscriptSeq: paramsForLog.lastUserTranscriptSeq,
      pendingBookingStepPromptAnchorSeq:
        paramsForLog.pendingBookingStepPromptAnchorSeq,
      flushBlockedReason: "DEFERRED_SUBMIT_NOT_FLUSHABLE_FOR_CURRENT_TURN",
    });

    deferredSubmitBookingStep = {
      event: null,
      reason: null,
    };

    return true;
  }

  function deferSubmitBookingStepUntilTranscriptIfNeeded(event: any): boolean {
    const realtimeState = params.getRealtimeState();
    const lastUserTranscript = params.getLastUserTranscript();
    const lastUserTranscriptSeq = params.getLastUserTranscriptSeq();

    if (
      !shouldDeferSubmitBookingStepUntilTranscript({
        event,
        realtimeState,
        lastUserTranscript,
        lastUserTranscriptSeq,
      })
    ) {
      return false;
    }

    const args = parseRealtimeToolArgs(event);

    deferredSubmitBookingStep = {
      event,
      reason: "WAITING_FOR_TRANSCRIPT_SEQ_ADVANCE",
    };

    console.warn("[VOICE_REALTIME][SUBMIT_BOOKING_STEP_DEFERRED]", {
      callSid: params.getCallSid(),
      toolName: getRealtimeToolName(event),
      submittedStepKey: String(args.step_key || "").trim(),
      pendingBookingStepKey: getPendingBookingStepKey(realtimeState),
      bookingTurnStatus: getBookingTurnStatus(realtimeState),
      lastUserTranscript,
      lastUserTranscriptSeq,
      pendingBookingStepPromptAnchorSeq:
        typeof (realtimeState as any).pendingBookingStepPromptAnchorSeq ===
        "number"
          ? (realtimeState as any).pendingBookingStepPromptAnchorSeq
          : null,
    });

    return true;
  }

  function flushDeferredSubmitBookingStepIfReady(reason: string): boolean {
    if (!deferredSubmitBookingStep.event) {
      return false;
    }

    const realtimeState = params.getRealtimeState();
    const lastUserTranscript = params.getLastUserTranscript();
    const lastUserTranscriptSeq = params.getLastUserTranscriptSeq();

    const check = canFlushDeferredSubmitBookingStep({
      event: deferredSubmitBookingStep.event,
      realtimeState,
      lastUserTranscript,
      lastUserTranscriptSeq,
    });

    if (check.ok) {
      const eventToFlush = deferredSubmitBookingStep.event;

      deferredSubmitBookingStep = {
        event: null,
        reason: null,
      };

      params.enqueueRealtimeToolCall(eventToFlush);
      return true;
    }

    if (
      check.submittedStepKey &&
      check.pendingStepKey &&
      check.submittedStepKey !== check.pendingStepKey
    ) {
      console.warn("[VOICE_REALTIME][DEFERRED_SUBMIT_BOOKING_STEP_DROPPED]", {
        callSid: params.getCallSid(),
        reason,
        deferredReason: deferredSubmitBookingStep.reason,
        submittedStepKey: check.submittedStepKey,
        pendingStepKey: check.pendingStepKey,
        bookingTurnStatus: check.bookingTurnStatus,
        lastUserTranscriptSeq,
        promptAnchorSeq: check.promptAnchorSeq,
      });

      deferredSubmitBookingStep = {
        event: null,
        reason: null,
      };

      return false;
    }

    return false;
  }

  function nudgeBookingStepProcessingAfterTranscript(): void {
    const realtimeState = params.getRealtimeState();
    const lastUserTranscript = params.getLastUserTranscript();
    const lastUserTranscriptSeq = params.getLastUserTranscriptSeq();

    const bookingTurnStatus = getBookingTurnStatus(realtimeState);
    const pendingBookingStepKey = getPendingBookingStepKey(realtimeState);

    const pendingBookingStepPromptAnchorSeq =
      getPendingBookingStepPromptAnchorSeq(realtimeState);

    const hasPendingBookingAnswer =
      bookingTurnStatus === "waiting_user_answer" &&
      !!pendingBookingStepKey &&
      lastUserTranscriptSeq > pendingBookingStepPromptAnchorSeq;

    if (!hasPendingBookingAnswer) {
      return;
    }

    const shouldAllowTranscriptNudgeForStep =
      pendingBookingStepKey === "service" ||
      pendingBookingStepKey === "datetime";

    if (!shouldAllowTranscriptNudgeForStep) {
      console.warn("[VOICE_REALTIME][BOOKING_STEP_TRANSCRIPT_NUDGE_SKIPPED]", {
        callSid: params.getCallSid(),
        reason: "STEP_NOT_NUDGE_ELIGIBLE",
        pendingBookingStepKey,
        lastUserTranscript,
        lastUserTranscriptSeq,
        pendingBookingStepPromptAnchorSeq,
      });

      return;
    }

    if (lastBookingTranscriptNudgeSeq === lastUserTranscriptSeq) {
      return;
    }

    if (!lastUserTranscript) {
      return;
    }

    clearStaleDeferredSubmitIfItCannotApplyToCurrentTurn({
      source: "booking_step_transcript_nudge",
      pendingBookingStepKey,
      lastUserTranscript,
      lastUserTranscriptSeq,
      pendingBookingStepPromptAnchorSeq,
    });

    if (deferredSubmitBookingStep.event) {
      console.warn("[VOICE_REALTIME][BOOKING_STEP_TRANSCRIPT_NUDGE_SKIPPED]", {
        callSid: params.getCallSid(),
        reason: "DEFERRED_SUBMIT_ALREADY_PENDING",
        pendingBookingStepKey,
        lastUserTranscript,
        lastUserTranscriptSeq,
      });

      return;
    }

    lastBookingTranscriptNudgeSeq = lastUserTranscriptSeq;

    console.warn("[VOICE_REALTIME][BOOKING_STEP_TRANSCRIPT_PROCESSING_NUDGED]", {
      callSid: params.getCallSid(),
      pendingBookingStepKey,
      lastUserTranscript,
      lastUserTranscriptSeq,
      pendingBookingStepPromptAnchorSeq,
    });

    params.requestRealtimeResponse(
      {
        instructions: [
          "The caller just answered the current booking step.",
          `Current booking step key: ${pendingBookingStepKey}.`,
          `Use this exact latest caller transcript as the answer: ${lastUserTranscript}`,
          "Call submit_booking_step for the current booking step now.",
          "Do not speak to the caller.",
          "Do not say progress updates.",
          "Do not say anything like 'we are moving forward with your booking'.",
          "Do not ask another question before calling the tool.",
          "Do not use an older transcript.",
          "Your only action in this response should be the tool call.",
        ].join(" "),
      },
      "tool_followup:booking_step_transcript_nudge"
    );
  }

  function catchUpBookingStepIfCallerAnsweredBeforeTurnOpened(): void {
    const realtimeState = params.getRealtimeState();
    const lastUserTranscript = params.getLastUserTranscript();
    const lastUserTranscriptSeq = params.getLastUserTranscriptSeq();

    const bookingTurnStatus = getBookingTurnStatus(realtimeState);
    const pendingBookingStepKey = getPendingBookingStepKey(realtimeState);

    const pendingBookingStepPromptAnchorSeq =
      getPendingBookingStepPromptAnchorSeq(realtimeState);

    const hasEarlyCallerAnswer =
      bookingTurnStatus === "waiting_user_answer" &&
      !!pendingBookingStepKey &&
      !!lastUserTranscript &&
      lastUserTranscriptSeq > pendingBookingStepPromptAnchorSeq;

    if (!hasEarlyCallerAnswer) {
      return;
    }

    const catchupAllowedSteps = new Set([
      "service",
      "staff",
      "datetime",
      "name",
      "phone",
      "confirm",
    ]);

    if (!catchupAllowedSteps.has(pendingBookingStepKey)) {
      console.warn("[VOICE_REALTIME][BOOKING_EARLY_ANSWER_CATCHUP_SKIPPED]", {
        callSid: params.getCallSid(),
        reason: "STEP_NOT_CATCHUP_ELIGIBLE",
        pendingBookingStepKey,
        lastUserTranscript,
        lastUserTranscriptSeq,
        pendingBookingStepPromptAnchorSeq,
      });

      return;
    }

    const catchupKey = [
      params.getCallSid() || "",
      pendingBookingStepKey,
      String(lastUserTranscriptSeq),
    ].join(":");

    if (lastBookingEarlyAnswerCatchupKey === catchupKey) {
      return;
    }

    if (lastBookingTranscriptNudgeSeq === lastUserTranscriptSeq) {
      console.warn("[VOICE_REALTIME][BOOKING_EARLY_ANSWER_CATCHUP_SKIPPED]", {
        callSid: params.getCallSid(),
        reason: "TRANSCRIPT_ALREADY_NUDGED",
        pendingBookingStepKey,
        lastUserTranscript,
        lastUserTranscriptSeq,
        pendingBookingStepPromptAnchorSeq,
      });

      return;
    }

    clearStaleDeferredSubmitIfItCannotApplyToCurrentTurn({
      source: "booking_step_early_answer_catchup",
      pendingBookingStepKey,
      lastUserTranscript,
      lastUserTranscriptSeq,
      pendingBookingStepPromptAnchorSeq,
    });

    if (deferredSubmitBookingStep.event) {
      console.warn("[VOICE_REALTIME][BOOKING_EARLY_ANSWER_CATCHUP_SKIPPED]", {
        callSid: params.getCallSid(),
        reason: "DEFERRED_SUBMIT_ALREADY_PENDING",
        pendingBookingStepKey,
        lastUserTranscript,
        lastUserTranscriptSeq,
        pendingBookingStepPromptAnchorSeq,
      });

      return;
    }

    lastBookingEarlyAnswerCatchupKey = catchupKey;

    console.warn("[VOICE_REALTIME][BOOKING_EARLY_ANSWER_CATCHUP_REQUESTED]", {
      callSid: params.getCallSid(),
      pendingBookingStepKey,
      lastUserTranscript,
      lastUserTranscriptSeq,
      pendingBookingStepPromptAnchorSeq,
    });

    params.requestRealtimeResponse(
      {
        instructions: [
          "The booking step has just opened, but the caller already answered it before the turn was fully opened.",
          `Current booking step key: ${pendingBookingStepKey}.`,
          `Use this exact latest caller transcript as the answer: ${lastUserTranscript}`,
          "Call submit_booking_step for the current booking step now.",
          "Do not speak to the caller.",
          "Do not say progress updates.",
          "Do not ask another question before calling the tool.",
          "Do not use an older transcript.",
          "Your only action in this response should be the tool call.",
        ].join(" "),
      },
      "tool_followup:booking_step_early_answer_catchup"
    );
  }

  return {
    reset,
    hasDeferredSubmitBookingStep,
    deferSubmitBookingStepUntilTranscriptIfNeeded,
    flushDeferredSubmitBookingStepIfReady,
    nudgeBookingStepProcessingAfterTranscript,
    catchUpBookingStepIfCallerAnsweredBeforeTurnOpened,
  };
}