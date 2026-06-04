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
    requestRealtimeResponse,
  } = params;

  const pendingStepKey = clean(realtimeState.pendingBookingStepKey);
  const pendingPrompt = clean(realtimeState.pendingBookingStepPrompt);
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

   /**
   * Case 1:
   * The server already processed this user's answer and advanced to another step.
   * OpenAI later emits the same old submit_booking_step.
   *
   * Example:
   * - submittedStepKey: staff
   * - pendingStepKey: datetime
   *
   * This stale submit must not change booking state, but it also must not leave
   * the caller without the current configured prompt.
   */
  const isAlreadyHandledDuplicateSubmit =
    (turnGateReason === "WRONG_STEP" ||
        turnGateReason === "STALE_DUPLICATE_SUBMIT") &&
    submittedStepKey &&
    submittedStepKey === lastSubmittedBookingStepKey &&
    sameTranscriptAlreadySubmitted;

  if (isAlreadyHandledDuplicateSubmit) {
    const shouldForceCurrentStepPromptAfterDuplicate =
      Boolean(pendingPrompt) &&
      Boolean(pendingStepKey) &&
      bookingTurnStatus === "waiting_user_answer";

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
      forcedCurrentStepPrompt: Boolean(shouldForceCurrentStepPromptAfterDuplicate),
      ignoredAlreadyHandledDuplicate: true,
      rejectedModelCorrectionDuringRetry: false,
    });

    if (shouldForceCurrentStepPromptAfterDuplicate) {
      requestRealtimeResponse(
        {
          instructions: [
            "A stale booking step submission was already handled by the server.",
            "Do not change the booking state.",
            `The current pending booking step is: ${pendingStepKey}.`,
            `Ask the caller this configured booking question now: ${pendingPrompt}`,
            "Ask only this one question.",
            "Do not repeat, reinterpret, or modify already collected booking details.",
            "Do not submit another booking step until the caller answers this current question.",
          ].join(" "),
        },
        "tool_guard:duplicate_stale_submit_force_current_step_prompt"
      );

      return {
        forcedCurrentStepPrompt: true,
        ignoredAlreadyHandledDuplicate: true,
        rejectedModelCorrectionDuringRetry: false,
      };
    }

    return {
      forcedCurrentStepPrompt: false,
      ignoredAlreadyHandledDuplicate: true,
      rejectedModelCorrectionDuringRetry: false,
    };
  }

  /**
   * Case 2:
   * The server tried to resolve the user's answer for the same step,
   * but the value was not reliable enough. While the assistant is supposed
   * to ask the retry prompt, OpenAI may try to submit an inferred value.
   *
   * Example:
   * - human transcript: "a day eleven a.m."
   * - model tool value: "Friday 11 a.m."
   *
   * That is not safe. We reject it and force the configured retry prompt.
   */
  const shouldRejectModelCorrectionDuringRetry =
    turnGateReason === "ASSISTANT_PROMPT_NOT_COMPLETED" &&
    bookingTurnStatus === "waiting_assistant_prompt" &&
    pendingPrompt &&
    pendingStepKey &&
    submittedStepKey &&
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
      forcedCurrentStepPrompt: true,
      ignoredAlreadyHandledDuplicate: false,
      rejectedModelCorrectionDuringRetry: true,
    });

    requestRealtimeResponse(
      {
        instructions: [
          "The previous submitted value for this booking step was not reliable enough to use.",
          `Ask the caller this configured retry question now: ${pendingPrompt}`,
          "Ask only this one question.",
          "Do not infer, guess, or replace the caller's answer.",
          "Do not submit another booking step until the caller gives a new answer.",
        ].join(" "),
      },
      "tool_guard:model_correction_rejected_retry_required"
    );

    return {
      forcedCurrentStepPrompt: true,
      ignoredAlreadyHandledDuplicate: false,
      rejectedModelCorrectionDuringRetry: true,
    };
  }

  /**
   * Case 3:
   * Stale submit for a different step, and the system is waiting for the
   * assistant to speak the current configured prompt.
   */
  const shouldForceCurrentStepPrompt =
    turnGateReason === "WRONG_STEP" &&
    Boolean(pendingPrompt) &&
    Boolean(pendingStepKey) &&
    Boolean(submittedStepKey) &&
    bookingTurnStatus === "waiting_user_answer";

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
    forcedCurrentStepPrompt: shouldForceCurrentStepPrompt,
    ignoredAlreadyHandledDuplicate: false,
    rejectedModelCorrectionDuringRetry: false,
  });

  if (!shouldForceCurrentStepPrompt) {
    return {
      forcedCurrentStepPrompt: false,
      ignoredAlreadyHandledDuplicate: false,
      rejectedModelCorrectionDuringRetry: false,
    };
  }

  requestRealtimeResponse(
    {
      instructions: [
        "The previous booking step submission was stale and does not match the current booking step.",
        `The current pending booking step is: ${pendingStepKey}.`,
        `Ask the caller this configured booking question now: ${pendingPrompt}`,
        "Ask only this one question.",
        "Do not repeat, reinterpret, or modify already collected booking details.",
        "Do not submit another booking step until the caller answers this current question.",
      ].join(" "),
    },
    "tool_guard:stale_submit_force_current_step_prompt"
  );

  return {
    forcedCurrentStepPrompt: true,
    ignoredAlreadyHandledDuplicate: false,
    rejectedModelCorrectionDuringRetry: false,
  };
}