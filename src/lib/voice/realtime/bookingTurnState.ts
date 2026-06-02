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
  reason?:
    | "NO_PENDING_STEP"
    | "WRONG_STEP"
    | "ASSISTANT_PROMPT_NOT_COMPLETED"
    | "NO_NEW_USER_ANSWER";
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

  const anchorSeq = finiteNumber(
    params.realtimeState.pendingBookingStepPromptAnchorSeq,
    -1
  );

  const currentSeq = finiteNumber(params.lastUserTranscriptSeq, -1);

  const hasNewUserAnswerAfterPrompt =
    anchorSeq >= 0 && currentSeq > anchorSeq;

  /**
   * Normal case:
   * The assistant already finished asking the booking question and the user
   * answered after that prompt.
   */
  if (status === "waiting_user_answer") {
    if (!hasNewUserAnswerAfterPrompt) {
      return { ok: false, reason: "NO_NEW_USER_ANSWER" };
    }

    return { ok: true };
  }

  /**
   * Realtime voice case:
   * The caller may answer while the assistant is still finishing the prompt.
   *
   * This is not a semantic decision. We only allow the submit if:
   * - there is a real pending step,
   * - the submitted step matches that pending step,
   * - the prompt anchor already exists,
   * - and a newer accepted user transcript exists after that anchor.
   *
   * The actual step validator still decides whether the value is valid.
   */
  if (status === "waiting_assistant_prompt") {
    if (hasNewUserAnswerAfterPrompt) {
      return { ok: true };
    }

    return { ok: false, reason: "ASSISTANT_PROMPT_NOT_COMPLETED" };
  }

  return { ok: false, reason: "ASSISTANT_PROMPT_NOT_COMPLETED" };
}