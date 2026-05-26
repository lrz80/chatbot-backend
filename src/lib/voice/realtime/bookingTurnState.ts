// src/lib/voice/realtime/bookingTurnState.ts
import type { CallState } from "../types";

export type BookingTurnStatus =
  | "idle"
  | "waiting_assistant_prompt"
  | "waiting_user_answer";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

export function getBookingTurnStatus(
  realtimeState: CallState
): BookingTurnStatus {
  const value = clean((realtimeState as any).bookingTurnStatus);

  if (
    value === "idle" ||
    value === "waiting_assistant_prompt" ||
    value === "waiting_user_answer"
  ) {
    return value;
  }

  return "idle";
}

export function markBookingWaitingForAssistantPrompt(params: {
  realtimeState: CallState;
  stepKey: string;
  prompt: string;
}): CallState {
  return {
    ...params.realtimeState,
    bookingTurnStatus: "waiting_assistant_prompt",
    pendingBookingStepKey: clean(params.stepKey),
    pendingBookingStepPrompt: clean(params.prompt),
    pendingBookingStepPromptAnchorTranscript: "",
    pendingBookingStepPromptAnchorSeq: -1,
  } as CallState;
}

export function markBookingWaitingForUserAnswer(params: {
  realtimeState: CallState;
  lastUserTranscriptSeq: number;
}): CallState {
  const currentStepKey = clean(params.realtimeState.pendingBookingStepKey);

  if (!currentStepKey) {
    return {
      ...params.realtimeState,
      bookingTurnStatus: "idle",
    } as CallState;
  }

  return {
    ...params.realtimeState,
    bookingTurnStatus: "waiting_user_answer",
    pendingBookingStepPromptAnchorSeq: finiteNumber(
      params.lastUserTranscriptSeq,
      -1
    ),
  } as CallState;
}

export function clearBookingTurnState(realtimeState: CallState): CallState {
  return {
    ...realtimeState,
    bookingTurnStatus: "idle",
    pendingBookingStepKey: "",
    pendingBookingStepRequired: undefined,
    pendingBookingStepPrompt: "",
    pendingBookingStepPromptAnchorTranscript: "",
    pendingBookingStepPromptAnchorSeq: -1,
  } as CallState;
}

export function canSubmitBookingStepNow(params: {
  realtimeState: CallState;
  submittedStepKey: string;
  lastUserTranscriptSeq: number;
}): {
  ok: boolean;
  reason?: "NO_PENDING_STEP" | "WRONG_STEP" | "ASSISTANT_PROMPT_NOT_COMPLETED" | "NO_NEW_USER_ANSWER";
} {
  const status = getBookingTurnStatus(params.realtimeState);
  const pendingStepKey = clean(params.realtimeState.pendingBookingStepKey);
  const submittedStepKey = clean(params.submittedStepKey);

  if (!pendingStepKey) {
    return { ok: false, reason: "NO_PENDING_STEP" };
  }

  if (submittedStepKey !== pendingStepKey) {
    return { ok: false, reason: "WRONG_STEP" };
  }

  if (status !== "waiting_user_answer") {
    return { ok: false, reason: "ASSISTANT_PROMPT_NOT_COMPLETED" };
  }

  const anchorSeq = finiteNumber(
    params.realtimeState.pendingBookingStepPromptAnchorSeq,
    -1
  );

  const currentSeq = finiteNumber(params.lastUserTranscriptSeq, -1);

  if (anchorSeq >= 0 && currentSeq <= anchorSeq) {
    return { ok: false, reason: "NO_NEW_USER_ANSWER" };
  }

  return { ok: true };
}