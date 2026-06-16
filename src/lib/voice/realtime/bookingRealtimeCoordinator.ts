// src/lib/voice/realtime/bookingRealtimeCoordinator.ts
import type { CallState } from "../types";
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

function hasDigit(value: string): boolean {
  return /\d/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getBookingTurnStatus(realtimeState: CallState): string {
  return clean((realtimeState as any).bookingTurnStatus);
}

function getPendingBookingStepExpectedType(realtimeState: CallState): string {
  return clean((realtimeState as any).pendingBookingStepExpectedType).toLowerCase();
}

function getPendingBookingStepSlot(realtimeState: CallState): string {
  return clean((realtimeState as any).pendingBookingStepSlot).toLowerCase();
}

function getPendingBookingStepPromptAnchorSeq(realtimeState: CallState): number {
  return typeof (realtimeState as any).pendingBookingStepPromptAnchorSeq === "number"
    ? (realtimeState as any).pendingBookingStepPromptAnchorSeq
    : -1;
}

function getPendingBookingStepValidationConfig(
  realtimeState: CallState
): Record<string, unknown> {
  const state = realtimeState as any;

  if (isRecord(state.pendingBookingStepValidationConfig)) {
    return state.pendingBookingStepValidationConfig;
  }

  if (isRecord(state.pendingBookingStep?.validation_config)) {
    return state.pendingBookingStep.validation_config;
  }

  if (isRecord(state.pendingBookingStep?.validationConfig)) {
    return state.pendingBookingStep.validationConfig;
  }

  if (isRecord(state.nextRequiredStep?.validation_config)) {
    return state.nextRequiredStep.validation_config;
  }

  if (isRecord(state.nextRequiredStep?.validationConfig)) {
    return state.nextRequiredStep.validationConfig;
  }

  if (isRecord(state.next_required_step?.validation_config)) {
    return state.next_required_step.validation_config;
  }

  return {};
}

function getPendingBookingStepValidationMode(realtimeState: CallState): string {
  const validationConfig = getPendingBookingStepValidationConfig(realtimeState);
  return clean(validationConfig.mode).toLowerCase();
}

function getPendingBookingStepUseInboundCaller(realtimeState: CallState): boolean {
  const validationConfig = getPendingBookingStepValidationConfig(realtimeState);

  return (
    validationConfig.use_inbound_caller === true ||
    validationConfig.useInboundCaller === true
  );
}

function canProcessEarlyAnswerForPendingStep(params: {
  bookingTurnStatus: string;
  pendingBookingStepKey: string;
}): boolean {
  if (params.bookingTurnStatus !== "waiting_assistant_prompt") {
    return false;
  }

  const earlyAnswerAllowedSteps = new Set([
    "phone",
    "confirm",
    "offer_booking_sms",
  ]);

  return earlyAnswerAllowedSteps.has(params.pendingBookingStepKey);
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
    slot === "datetime" ||
    expectedType === "phone" ||
    expectedType === "email" ||
    expectedType === "datetime" ||
    validationMode === "confirm_or_replace"
  );
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

  function reset(): void {
    lastBookingTranscriptNudgeSeq = 0;
    lastBookingEarlyAnswerCatchupKey = "";
    lastBookingNumberModelResolutionKey = "";
    lastBookingNormalizedModelResolutionKey = "";
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

    const pendingSlot = getPendingBookingStepSlot(realtimeState);
    const expectedType = getPendingBookingStepExpectedType(realtimeState);
    const validationMode = getPendingBookingStepValidationMode(realtimeState);
    const useInboundCaller = getPendingBookingStepUseInboundCaller(realtimeState);

    requestNormalizedStepModelResolution({
      callSid: params.getCallSid(),
      source: paramsForResolution.source,
      pendingBookingStepKey: paramsForResolution.pendingBookingStepKey,
      pendingSlot,
      expectedType,
      validationMode,
      useInboundCaller,
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

  function submitCurrentTranscriptForPendingStep(paramsForSubmit: {
    source: string;
    realtimeState: CallState;
    pendingBookingStepKey: string;
    lastUserTranscript: string;
    lastUserTranscriptSeq: number;
    pendingBookingStepPromptAnchorSeq: number;
  }): void {
    const {
      source,
      realtimeState,
      pendingBookingStepKey,
      lastUserTranscript,
      lastUserTranscriptSeq,
      pendingBookingStepPromptAnchorSeq,
    } = paramsForSubmit;

    if (
      wasLatestTranscriptAlreadySubmittedForStep({
        realtimeState,
        pendingBookingStepKey,
        lastUserTranscript,
        lastUserTranscriptSeq,
      })
    ) {
      console.warn("[VOICE_REALTIME][BOOKING_STEP_TRANSCRIPT_SUBMIT_SKIPPED]", {
        callSid: params.getCallSid(),
        source,
        reason: "TRANSCRIPT_ALREADY_SUBMITTED_FOR_STEP",
        pendingBookingStepKey,
        lastUserTranscript,
        lastUserTranscriptSeq,
        pendingBookingStepPromptAnchorSeq,
      });

      return;
    }

    if (pendingBookingStepKey === "service") {
      requestServiceStepModelResolution({
        callSid: params.getCallSid(),
        source,
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
        source,
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
      source,
    });
  }

  function nudgeBookingStepProcessingAfterTranscript(): void {
    const realtimeState = params.getRealtimeState();
    const lastUserTranscript = params.getLastUserTranscript();
    const lastUserTranscriptSeq = params.getLastUserTranscriptSeq();

    const bookingTurnStatus = getBookingTurnStatus(realtimeState);
    const pendingBookingStepKey = clean(
      (realtimeState as any).pendingBookingStepKey
    );

    const pendingBookingStepPromptAnchorSeq =
      getPendingBookingStepPromptAnchorSeq(realtimeState);

    const hasFreshTranscriptForPendingStep =
      !!pendingBookingStepKey &&
      !!lastUserTranscript &&
      lastUserTranscriptSeq > pendingBookingStepPromptAnchorSeq;

    const canProcessRegularAnswer =
      bookingTurnStatus === "waiting_user_answer" &&
      hasFreshTranscriptForPendingStep;

    const canProcessEarlyAnswer =
      canProcessEarlyAnswerForPendingStep({
        bookingTurnStatus,
        pendingBookingStepKey,
      }) && hasFreshTranscriptForPendingStep;

    if (!canProcessRegularAnswer && !canProcessEarlyAnswer) {
      return;
    }

    if (lastBookingTranscriptNudgeSeq === lastUserTranscriptSeq) {
      return;
    }

    lastBookingTranscriptNudgeSeq = lastUserTranscriptSeq;

    console.warn("[VOICE_REALTIME][BOOKING_STEP_TRANSCRIPT_PROCESSING_NUDGED]", {
      callSid: params.getCallSid(),
      pendingBookingStepKey,
      lastUserTranscript,
      lastUserTranscriptSeq,
      pendingBookingStepPromptAnchorSeq,
      bookingTurnStatus,
    });

    submitCurrentTranscriptForPendingStep({
      source: "booking_step_transcript_nudge",
      realtimeState,
      pendingBookingStepKey,
      lastUserTranscript,
      lastUserTranscriptSeq,
      pendingBookingStepPromptAnchorSeq,
    });
  }

  function catchUpBookingStepIfCallerAnsweredBeforeTurnOpened(): void {
    const realtimeState = params.getRealtimeState();
    const lastUserTranscript = params.getLastUserTranscript();
    const lastUserTranscriptSeq = params.getLastUserTranscriptSeq();

    const bookingTurnStatus = getBookingTurnStatus(realtimeState);
    const pendingBookingStepKey = clean(
      (realtimeState as any).pendingBookingStepKey
    );

    const pendingBookingStepPromptAnchorSeq =
      getPendingBookingStepPromptAnchorSeq(realtimeState);

    const hasFreshTranscriptForPendingStep =
      !!pendingBookingStepKey &&
      !!lastUserTranscript &&
      lastUserTranscriptSeq > pendingBookingStepPromptAnchorSeq;

    const hasEarlyCallerAnswer =
      hasFreshTranscriptForPendingStep &&
      (bookingTurnStatus === "waiting_user_answer" ||
        canProcessEarlyAnswerForPendingStep({
          bookingTurnStatus,
          pendingBookingStepKey,
        }));

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
      "offer_booking_sms",
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
      bookingTurnStatus,
    });

    submitCurrentTranscriptForPendingStep({
      source: "booking_step_early_answer_catchup",
      realtimeState,
      pendingBookingStepKey,
      lastUserTranscript,
      lastUserTranscriptSeq,
      pendingBookingStepPromptAnchorSeq,
    });
  }

  return {
    reset,
    nudgeBookingStepProcessingAfterTranscript,
    catchUpBookingStepIfCallerAnsweredBeforeTurnOpened,
  };
}