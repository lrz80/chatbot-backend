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

export function handleStaleSubmitBookingStepPrompt(
  params: HandleStaleSubmitBookingStepPromptParams
): {
  forcedCurrentStepPrompt: boolean;
  ignoredAlreadyHandledDuplicate: boolean;
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

  const lastUserTranscriptSeq =
    typeof realtimeState.lastUserTranscriptSeq === "number"
      ? realtimeState.lastUserTranscriptSeq
      : -1;

  const lastSubmittedBookingTranscriptSeq =
    typeof realtimeState.lastSubmittedBookingTranscriptSeq === "number"
      ? realtimeState.lastSubmittedBookingTranscriptSeq
      : -1;

  /**
   * This is the common OpenAI realtime race:
   * 1. Server synthetic submit already processed the user's answer.
   * 2. Runtime advanced to the next step.
   * 3. OpenAI later emits a stale submit_booking_step for the old step.
   *
   * In this case we should not force another assistant prompt, because the
   * normal tool follow-up for the current step is already responsible for
   * speaking the next configured prompt.
   */
  const isAlreadyHandledDuplicateSubmit =
    turnGateReason === "WRONG_STEP" &&
    submittedStepKey &&
    submittedStepKey === lastSubmittedBookingStepKey &&
    lastUserTranscriptSeq > -1 &&
    lastSubmittedBookingTranscriptSeq > -1 &&
    lastSubmittedBookingTranscriptSeq === lastUserTranscriptSeq;

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
    });

    return {
      forcedCurrentStepPrompt: false,
      ignoredAlreadyHandledDuplicate: true,
    };
  }

  const shouldForceCurrentStepPrompt =
    turnGateReason === "WRONG_STEP" &&
    pendingPrompt &&
    pendingStepKey &&
    submittedStepKey &&
    submittedStepKey !== pendingStepKey &&
    bookingTurnStatus === "waiting_assistant_prompt";

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
  });

  if (!shouldForceCurrentStepPrompt) {
    return {
      forcedCurrentStepPrompt: false,
      ignoredAlreadyHandledDuplicate: false,
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
  };
}