//src/lib/voice/realtime/toolGuards/handleStaleSubmitBookingStepPrompt.ts
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
      typeof realtimeState.lastUserTranscriptSeq === "number"
        ? realtimeState.lastUserTranscriptSeq
        : null,
    lastSubmittedBookingStepKey:
      realtimeState.lastSubmittedBookingStepKey || "",
    lastSubmittedBookingTranscriptSeq:
      typeof realtimeState.lastSubmittedBookingTranscriptSeq === "number"
        ? realtimeState.lastSubmittedBookingTranscriptSeq
        : null,
    forcedCurrentStepPrompt: shouldForceCurrentStepPrompt,
  });

  if (!shouldForceCurrentStepPrompt) {
    return {
      forcedCurrentStepPrompt: false,
    };
  }

  requestRealtimeResponse(
    {
      instructions: [
        "The previous booking step submission was already handled by the server.",
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
  };
}