// src/lib/voice/realtime/toolGuards/handleStaleSubmitBookingStepPrompt.ts
import type { CallState } from "../../types";

type HandleStaleSubmitBookingStepPromptParams = {
  callSid: string | null;
  realtimeState: CallState;
  turnGateReason: string;
  submittedStepKey: string;
  lastUserTranscript: string;
  requestRealtimeResponse: (
    response?: Record<string, unknown>,
    source?: string
  ) => void;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function getNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : -1;
}

export function handleStaleSubmitBookingStepPrompt(
  params: HandleStaleSubmitBookingStepPromptParams
): {
  forcedCurrentStepPrompt: boolean;
  ignoredAlreadyHandledDuplicate: boolean;
  rejectedModelCorrectionDuringRetry: boolean;
} {
  const {
    callSid,
    realtimeState,
    turnGateReason,
    submittedStepKey,
    lastUserTranscript,
  } = params;

  const pendingStepKey = clean(realtimeState.pendingBookingStepKey);
  const bookingTurnStatus = clean((realtimeState as any).bookingTurnStatus);

  const lastSubmittedBookingStepKey = clean(
    realtimeState.lastSubmittedBookingStepKey
  );

  const lastUserTranscriptSeq = getNumber(realtimeState.lastUserTranscriptSeq);

  const lastSubmittedBookingTranscriptSeq = getNumber(
    realtimeState.lastSubmittedBookingTranscriptSeq
  );

  const sameTranscriptAlreadySubmitted =
    lastUserTranscriptSeq > -1 &&
    lastSubmittedBookingTranscriptSeq > -1 &&
    lastSubmittedBookingTranscriptSeq === lastUserTranscriptSeq;

  const isAlreadyHandledDuplicateSubmit =
    (turnGateReason === "WRONG_STEP" ||
      turnGateReason === "STALE_DUPLICATE_SUBMIT") &&
    Boolean(submittedStepKey) &&
    submittedStepKey === lastSubmittedBookingStepKey &&
    sameTranscriptAlreadySubmitted;

  if (isAlreadyHandledDuplicateSubmit) {
    console.warn("[VOICE_REALTIME][BOOKING_BLOCKED_SUBMIT_SILENTLY_IGNORED]", {
      callSid,
      reason: turnGateReason,
      submittedStepKey,
      pendingBookingStepKey: pendingStepKey,
      bookingTurnStatus,
      lastUserTranscript,
      lastUserTranscriptSeq,
      lastSubmittedBookingStepKey,
      lastSubmittedBookingTranscriptSeq,
      forcedCurrentStepPrompt: false,
      ignoredAlreadyHandledDuplicate: true,
      rejectedModelCorrectionDuringRetry: false,
    });

    return {
      forcedCurrentStepPrompt: false,
      ignoredAlreadyHandledDuplicate: true,
      rejectedModelCorrectionDuringRetry: false,
    };
  }

  const shouldRejectModelCorrectionDuringRetry =
    turnGateReason === "ASSISTANT_PROMPT_NOT_COMPLETED" &&
    bookingTurnStatus === "waiting_assistant_prompt" &&
    Boolean(pendingStepKey) &&
    Boolean(submittedStepKey) &&
    submittedStepKey === pendingStepKey &&
    submittedStepKey === lastSubmittedBookingStepKey &&
    sameTranscriptAlreadySubmitted;

  if (shouldRejectModelCorrectionDuringRetry) {
    console.warn("[VOICE_REALTIME][BOOKING_MODEL_CORRECTION_REJECTED_RETRY_REQUIRED]", {
      callSid,
      reason: turnGateReason,
      submittedStepKey,
      pendingBookingStepKey: pendingStepKey,
      bookingTurnStatus,
      lastUserTranscript,
      lastUserTranscriptSeq,
      lastSubmittedBookingStepKey,
      lastSubmittedBookingTranscriptSeq,
      forcedCurrentStepPrompt: false,
      ignoredAlreadyHandledDuplicate: false,
      rejectedModelCorrectionDuringRetry: true,
    });

    return {
      forcedCurrentStepPrompt: false,
      ignoredAlreadyHandledDuplicate: false,
      rejectedModelCorrectionDuringRetry: true,
    };
  }

  const isWrongStep =
    turnGateReason === "WRONG_STEP" &&
    Boolean(pendingStepKey) &&
    Boolean(submittedStepKey);

  console.warn("[VOICE_REALTIME][BOOKING_BLOCKED_SUBMIT_SILENTLY_IGNORED]", {
    callSid,
    reason: turnGateReason,
    submittedStepKey,
    pendingBookingStepKey: pendingStepKey,
    bookingTurnStatus,
    lastUserTranscript,
    lastUserTranscriptSeq:
      lastUserTranscriptSeq > -1 ? lastUserTranscriptSeq : null,
    lastSubmittedBookingStepKey,
    lastSubmittedBookingTranscriptSeq:
      lastSubmittedBookingTranscriptSeq > -1
        ? lastSubmittedBookingTranscriptSeq
        : null,
    forcedCurrentStepPrompt: false,
    ignoredAlreadyHandledDuplicate: false,
    rejectedModelCorrectionDuringRetry: false,
  });

  return {
    forcedCurrentStepPrompt: false,
    ignoredAlreadyHandledDuplicate: false,
    rejectedModelCorrectionDuringRetry: false,
  };
}