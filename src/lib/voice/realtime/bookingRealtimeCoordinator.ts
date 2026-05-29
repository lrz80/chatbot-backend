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
      pendingBookingStepKey: String(
        (realtimeState as any).pendingBookingStepKey || ""
      ).trim(),
      bookingTurnStatus: String(
        (realtimeState as any).bookingTurnStatus || ""
      ).trim(),
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

    const bookingTurnStatus = clean((realtimeState as any).bookingTurnStatus);
    const pendingBookingStepKey = clean(
      (realtimeState as any).pendingBookingStepKey
    );

    const pendingBookingStepPromptAnchorSeq =
      typeof (realtimeState as any).pendingBookingStepPromptAnchorSeq ===
      "number"
        ? (realtimeState as any).pendingBookingStepPromptAnchorSeq
        : -1;

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

    const bookingTurnStatus = clean((realtimeState as any).bookingTurnStatus);
    const pendingBookingStepKey = clean(
      (realtimeState as any).pendingBookingStepKey
    );

    const pendingBookingStepPromptAnchorSeq =
      typeof (realtimeState as any).pendingBookingStepPromptAnchorSeq ===
      "number"
        ? (realtimeState as any).pendingBookingStepPromptAnchorSeq
        : -1;

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