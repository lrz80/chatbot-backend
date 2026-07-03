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

export function isBookingLanguageLocked(realtimeState: CallState): boolean {
  return Boolean((realtimeState as any).bookingLanguageLocked);
}

export function getBookingLockedLocale(realtimeState: CallState): string {
  return clean((realtimeState as any).bookingLockedLocale);
}

export function getBookingLockedLanguageSample(
  realtimeState: CallState
): string {
  return clean((realtimeState as any).bookingLockedLanguageSample);
}

export function lockBookingLanguage(params: {
  realtimeState: CallState;
  currentLocale: string;
  lastUserTranscript: string;
  lastAssistantTranscript?: string;
  conversationLanguage?: string;
}): CallState {
  const existingLocale = getBookingLockedLocale(params.realtimeState);
  const existingSample = getBookingLockedLanguageSample(params.realtimeState);

  if (isBookingLanguageLocked(params.realtimeState) && existingSample) {
    return params.realtimeState;
  }

  const userSample = clean(params.lastUserTranscript);
  const assistantSample = clean(params.lastAssistantTranscript || "");
  const conversationLanguage = clean(params.conversationLanguage || "");
  const currentLocale = clean(params.currentLocale);

  const languageSample = [
    userSample ? `Caller latest message: ${userSample}` : "",
    assistantSample ? `Previous assistant message: ${assistantSample}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    ...params.realtimeState,
    bookingLanguageLocked: true,

    // Important:
    // Do not rely only on currentLocale because it can lag behind the
    // actual spoken language. conversationLanguage is preferred when present.
    bookingLockedLocale: conversationLanguage || currentLocale || null,

    // This is the strongest signal. The renderer can infer any language
    // from natural text, without hardcoding ES/EN/PT/etc.
    bookingLockedLanguageSample:
      languageSample || existingSample || userSample || assistantSample || null,
  } as CallState;
}

export function unlockBookingLanguage(realtimeState: CallState): CallState {
  return {
    ...realtimeState,
    bookingLanguageLocked: false,
    bookingLockedLocale: null,
    bookingLockedLanguageSample: null,
  } as CallState;
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
    ...unlockBookingLanguage(realtimeState),
    bookingTurnStatus: "idle",
    pendingBookingStepKey: "",
    pendingBookingStepRequired: undefined,
    pendingBookingStepPrompt: "",
    pendingBookingStepPromptAnchorTranscript: "",
    pendingBookingStepPromptAnchorSeq: -1,
  } as CallState;
}