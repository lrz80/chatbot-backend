// src/lib/voice/realtime/bookingRealtimeCoordinator.ts
import type { CallState } from "../types";
import {
  canFlushDeferredSubmitBookingStep,
  getRealtimeToolName,
  parseRealtimeToolArgs,
  shouldDeferSubmitBookingStepUntilTranscript,
  type DeferredSubmitBookingStepState,
} from "./deferredSubmitBookingStep";
import { requestServiceStepModelResolution } from "./bookingStep/requestServiceStepModelResolution";
import { requestNumberStepModelResolution } from "./bookingStep/requestNumberStepModelResolution";
import { requestNormalizedStepModelResolution } from "./bookingStep/requestNormalizedStepModelResolution";

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
  enqueueSubmitBookingStepFromTranscript: (params: {
    stepKey: string;
    value: string;
    source: string;
  }) => void;
  requestRealtimeResponse: RequestRealtimeResponse;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function getBookingTurnStatus(realtimeState: CallState): string {
  return clean((realtimeState as any).bookingTurnStatus);
}

function hasDigit(value: string): boolean {
  return /\d/.test(value);
}

function getPendingBookingStepExpectedType(realtimeState: CallState): string {
  return clean((realtimeState as any).pendingBookingStepExpectedType).toLowerCase();
}

function getPendingBookingStepSlot(realtimeState: CallState): string {
  return clean((realtimeState as any).pendingBookingStepSlot).toLowerCase();
}

function getPendingBookingStepValidationMode(realtimeState: CallState): string {
  return clean(
    (realtimeState as any).pendingBookingStepValidationConfig?.mode
  ).toLowerCase();
}

function getPendingBookingStepPromptAnchorSeq(realtimeState: CallState): number {
  return typeof (realtimeState as any).pendingBookingStepPromptAnchorSeq ===
    "number"
    ? (realtimeState as any).pendingBookingStepPromptAnchorSeq
    : -1;
}

function shouldRequestNumberModelResolution(params: {
  realtimeState: CallState;
  lastUserTranscript: string;
}): boolean {
  const expectedType = getPendingBookingStepExpectedType(params.realtimeState);
  const lastUserTranscript = clean(params.lastUserTranscript);

  return (
    expectedType === "number" &&
    !!lastUserTranscript &&
    !hasDigit(lastUserTranscript)
  );
}

function shouldRequestNormalizedModelResolution(params: {
  realtimeState: CallState;
  lastUserTranscript: string;
}): boolean {
  const lastUserTranscript = clean(params.lastUserTranscript);
  if (!lastUserTranscript) return false;

  const expectedType = getPendingBookingStepExpectedType(params.realtimeState);
  const slot = getPendingBookingStepSlot(params.realtimeState);
  const validationMode = getPendingBookingStepValidationMode(params.realtimeState);

  return (
    slot === "service_address" ||
    slot === "customer_phone" ||
    slot === "customer_email" ||
    expectedType === "phone" ||
    expectedType === "email" ||
    validationMode === "confirm_or_replace"
  );
}

function getDeferredSubmittedStepKey(
  deferredSubmitBookingStep: DeferredSubmitBookingStepState
): string {
  if (!deferredSubmitBookingStep.event) return "";

  const args = parseRealtimeToolArgs(deferredSubmitBookingStep.event);
  return clean(args.step_key);
}

function wasLatestTranscriptAlreadySubmittedForStep(params: {
  realtimeState: CallState;
  pendingBookingStepKey: string;
  lastUserTranscript: string;
  lastUserTranscriptSeq: number;
}): boolean {
  const state = params.realtimeState as any;

  const lastSubmittedStepKey = clean(state.lastSubmittedStepKey);
  const lastSubmittedTranscript = clean(state.lastSubmittedTranscript);
  const lastSubmittedTranscriptSeq =
    typeof state.lastSubmittedTranscriptSeq === "number"
      ? state.lastSubmittedTranscriptSeq
      : -1;

  return (
    lastSubmittedStepKey === params.pendingBookingStepKey &&
    lastSubmittedTranscriptSeq === params.lastUserTranscriptSeq &&
    lastSubmittedTranscript === clean(params.lastUserTranscript)
  );
}

export function createBookingRealtimeCoordinator(
  params: BookingRealtimeCoordinatorParams
) {
  let lastBookingTranscriptNudgeSeq = 0;
  let lastBookingEarlyAnswerCatchupKey = "";
  let lastBookingNumberModelResolutionKey = "";
  let lastBookingNormalizedModelResolutionKey = "";

  let deferredSubmitBookingStep: DeferredSubmitBookingStepState = {
    event: null,
    reason: null,
  };

  function reset(): void {
    lastBookingTranscriptNudgeSeq = 0;
    lastBookingEarlyAnswerCatchupKey = "";
    lastBookingNumberModelResolutionKey = "";
    lastBookingNormalizedModelResolutionKey = "";
    deferredSubmitBookingStep = {
      event: null,
      reason: null,
    };
  }

  function hasDeferredSubmitBookingStep(): boolean {
    return Boolean(deferredSubmitBookingStep.event);
  }

  function clearDeferredSubmitIfLatestTranscriptBelongsToCurrentStep(paramsForLog: {
    source: string;
    pendingBookingStepKey: string;
    lastUserTranscript: string;
    lastUserTranscriptSeq: number;
    pendingBookingStepPromptAnchorSeq: number;
  }): void {
    if (!deferredSubmitBookingStep.event) return;

    const realtimeState = params.getRealtimeState();

    const submittedStepKey = getDeferredSubmittedStepKey(
      deferredSubmitBookingStep
    );

    const bookingTurnStatus = getBookingTurnStatus(realtimeState);

    const isWaitingForSameStep =
      bookingTurnStatus === "waiting_user_answer" &&
      submittedStepKey === paramsForLog.pendingBookingStepKey;

    const hasFreshHumanAnswerForCurrentStep =
      paramsForLog.lastUserTranscriptSeq >
      paramsForLog.pendingBookingStepPromptAnchorSeq;

    if (!isWaitingForSameStep || !hasFreshHumanAnswerForCurrentStep) {
      return;
    }

    console.warn("[VOICE_REALTIME][DEFERRED_SUBMIT_BOOKING_STEP_CLEARED_FOR_FRESH_TRANSCRIPT]", {
      callSid: params.getCallSid(),
      source: paramsForLog.source,
      deferredReason: deferredSubmitBookingStep.reason,
      submittedStepKey,
      pendingBookingStepKey: paramsForLog.pendingBookingStepKey,
      bookingTurnStatus,
      lastUserTranscript: paramsForLog.lastUserTranscript,
      lastUserTranscriptSeq: paramsForLog.lastUserTranscriptSeq,
      pendingBookingStepPromptAnchorSeq:
        paramsForLog.pendingBookingStepPromptAnchorSeq,
    });

    deferredSubmitBookingStep = {
      event: null,
      reason: null,
    };
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

  function requestNumberResolutionOnce(paramsForResolution: {
    source: string;
    pendingBookingStepKey: string;
    lastUserTranscript: string;
    lastUserTranscriptSeq: number;
    pendingBookingStepPromptAnchorSeq: number;
  }): boolean {
    const resolutionKey = [
      params.getCallSid() || "",
      paramsForResolution.source,
      paramsForResolution.pendingBookingStepKey,
      String(paramsForResolution.lastUserTranscriptSeq),
      "number",
    ].join(":");

    if (lastBookingNumberModelResolutionKey === resolutionKey) {
      return true;
    }

    lastBookingNumberModelResolutionKey = resolutionKey;

    requestNumberStepModelResolution({
      callSid: params.getCallSid(),
      source: paramsForResolution.source,
      pendingBookingStepKey: paramsForResolution.pendingBookingStepKey,
      lastUserTranscript: paramsForResolution.lastUserTranscript,
      lastUserTranscriptSeq: paramsForResolution.lastUserTranscriptSeq,
      pendingBookingStepPromptAnchorSeq:
        paramsForResolution.pendingBookingStepPromptAnchorSeq,
      requestRealtimeResponse: params.requestRealtimeResponse,
    });

    return true;
  }

  function requestNormalizedResolutionOnce(paramsForResolution: {
    source: string;
    pendingBookingStepKey: string;
    lastUserTranscript: string;
    lastUserTranscriptSeq: number;
    pendingBookingStepPromptAnchorSeq: number;
  }): boolean {
    const realtimeState = params.getRealtimeState();

    const resolutionKey = [
      params.getCallSid() || "",
      paramsForResolution.source,
      paramsForResolution.pendingBookingStepKey,
      String(paramsForResolution.lastUserTranscriptSeq),
      "normalized",
    ].join(":");

    if (lastBookingNormalizedModelResolutionKey === resolutionKey) {
      return true;
    }

    lastBookingNormalizedModelResolutionKey = resolutionKey;

    requestNormalizedStepModelResolution({
      callSid: params.getCallSid(),
      source: paramsForResolution.source,
      pendingBookingStepKey: paramsForResolution.pendingBookingStepKey,
      pendingSlot: getPendingBookingStepSlot(realtimeState),
      expectedType: getPendingBookingStepExpectedType(realtimeState),
      validationMode: getPendingBookingStepValidationMode(realtimeState),
      lastUserTranscript: paramsForResolution.lastUserTranscript,
      lastUserTranscriptSeq: paramsForResolution.lastUserTranscriptSeq,
      pendingBookingStepPromptAnchorSeq:
        paramsForResolution.pendingBookingStepPromptAnchorSeq,
      requestRealtimeResponse: params.requestRealtimeResponse,
    });

    return true;
  }

  function maybeRequestModelResolutionBeforeRawSubmit(paramsForResolution: {
    source: string;
    realtimeState: CallState;
    pendingBookingStepKey: string;
    lastUserTranscript: string;
    lastUserTranscriptSeq: number;
    pendingBookingStepPromptAnchorSeq: number;
  }): boolean {
    if (
      shouldRequestNumberModelResolution({
        realtimeState: paramsForResolution.realtimeState,
        lastUserTranscript: paramsForResolution.lastUserTranscript,
      })
    ) {
      return requestNumberResolutionOnce({
        source: paramsForResolution.source,
        pendingBookingStepKey: paramsForResolution.pendingBookingStepKey,
        lastUserTranscript: paramsForResolution.lastUserTranscript,
        lastUserTranscriptSeq: paramsForResolution.lastUserTranscriptSeq,
        pendingBookingStepPromptAnchorSeq:
          paramsForResolution.pendingBookingStepPromptAnchorSeq,
      });
    }

    if (
      shouldRequestNormalizedModelResolution({
        realtimeState: paramsForResolution.realtimeState,
        lastUserTranscript: paramsForResolution.lastUserTranscript,
      })
    ) {
      return requestNormalizedResolutionOnce({
        source: paramsForResolution.source,
        pendingBookingStepKey: paramsForResolution.pendingBookingStepKey,
        lastUserTranscript: paramsForResolution.lastUserTranscript,
        lastUserTranscriptSeq: paramsForResolution.lastUserTranscriptSeq,
        pendingBookingStepPromptAnchorSeq:
          paramsForResolution.pendingBookingStepPromptAnchorSeq,
      });
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
      getPendingBookingStepPromptAnchorSeq(realtimeState);

    const hasPendingBookingAnswer =
      bookingTurnStatus === "waiting_user_answer" &&
      !!pendingBookingStepKey &&
      lastUserTranscriptSeq > pendingBookingStepPromptAnchorSeq;

    if (!hasPendingBookingAnswer) {
      return;
    }

    if (lastBookingTranscriptNudgeSeq === lastUserTranscriptSeq) {
      return;
    }

    if (!lastUserTranscript) {
      return;
    }

    clearDeferredSubmitIfLatestTranscriptBelongsToCurrentStep({
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

    if (pendingBookingStepKey === "service") {
      requestServiceStepModelResolution({
        callSid: params.getCallSid(),
        source: "booking_step_transcript_nudge",
        pendingBookingStepKey,
        lastUserTranscript,
        lastUserTranscriptSeq,
        pendingBookingStepPromptAnchorSeq,
        requestRealtimeResponse: params.requestRealtimeResponse,
      });

      return;
    }

    if (
      maybeRequestModelResolutionBeforeRawSubmit({
        source: "booking_step_transcript_nudge",
        realtimeState,
        pendingBookingStepKey,
        lastUserTranscript,
        lastUserTranscriptSeq,
        pendingBookingStepPromptAnchorSeq,
      })
    ) {
      return;
    }

    params.enqueueSubmitBookingStepFromTranscript({
      stepKey: pendingBookingStepKey,
      value: lastUserTranscript,
      source: "booking_step_transcript_nudge",
    });
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
      "service_address",
      "customer_email",
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

    clearDeferredSubmitIfLatestTranscriptBelongsToCurrentStep({
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

    if (
      wasLatestTranscriptAlreadySubmittedForStep({
        realtimeState,
        pendingBookingStepKey,
        lastUserTranscript,
        lastUserTranscriptSeq,
      })
    ) {
      console.warn("[VOICE_REALTIME][BOOKING_EARLY_ANSWER_CATCHUP_SKIPPED]", {
        callSid: params.getCallSid(),
        reason: "TRANSCRIPT_ALREADY_SUBMITTED_FOR_STEP",
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

    if (pendingBookingStepKey === "service") {
      requestServiceStepModelResolution({
        callSid: params.getCallSid(),
        source: "booking_step_early_answer_catchup",
        pendingBookingStepKey,
        lastUserTranscript,
        lastUserTranscriptSeq,
        pendingBookingStepPromptAnchorSeq,
        requestRealtimeResponse: params.requestRealtimeResponse,
      });

      return;
    }

    if (
      maybeRequestModelResolutionBeforeRawSubmit({
        source: "booking_step_early_answer_catchup",
        realtimeState,
        pendingBookingStepKey,
        lastUserTranscript,
        lastUserTranscriptSeq,
        pendingBookingStepPromptAnchorSeq,
      })
    ) {
      return;
    }

    params.enqueueSubmitBookingStepFromTranscript({
      stepKey: pendingBookingStepKey,
      value: lastUserTranscript,
      source: "booking_step_early_answer_catchup",
    });
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