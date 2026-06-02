// src/lib/voice/realtime/transcriptGuards/guardRealtimeUserTranscript.ts
import type { CallState } from "../../types";

export type RealtimeTranscriptGuardResult =
  | {
      ok: true;
      reason: "ACCEPTED";
    }
  | {
      ok: false;
      reason:
        | "EMPTY_TRANSCRIPT"
        | "MATCHES_PENDING_ASSISTANT_PROMPT"
        | "ASSISTANT_AUDIO_ACTIVE_BEFORE_USER_TURN"
        | "SHORT_TRANSCRIPT_DURING_ASSISTANT_AUDIO";
    };

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeForTranscriptGuard(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getWordCount(value: string): number {
  return normalizeForTranscriptGuard(value).split(/\s+/).filter(Boolean).length;
}

function isPendingBookingAnswerWindow(state: any): boolean {
  const bookingTurnStatus = clean(state.bookingTurnStatus);
  const pendingBookingStepKey = clean(state.pendingBookingStepKey);

  if (!pendingBookingStepKey) {
    return false;
  }

  return (
    bookingTurnStatus === "waiting_user_answer" ||
    bookingTurnStatus === "waiting_assistant_prompt"
  );
}

function isShortBookingAnswerAllowed(params: {
  state: any;
  wordCount: number;
}): boolean {
  const { state, wordCount } = params;

  if (wordCount < 1 || wordCount > 4) {
    return false;
  }

  if (!isPendingBookingAnswerWindow(state)) {
    return false;
  }

  const expectedType = clean(state.pendingBookingStepExpectedType).toLowerCase();
  const pendingStepKey = clean(state.pendingBookingStepKey);
  const pendingSlot = clean(state.pendingBookingStepSlot);
  const validationMode = clean(
    state.pendingBookingStepValidationConfig?.mode
  ).toLowerCase();

  /**
   * Do not decide here whether the answer means yes/no/phone/etc.
   * This guard only decides whether the transcript should be allowed into
   * the booking pipeline. The actual step validator/tool resolver remains
   * the source of truth.
   */
  return (
    expectedType === "confirmation" ||
    expectedType === "phone" ||
    validationMode === "confirm_or_replace" ||
    pendingSlot === "confirmation" ||
    pendingSlot === "customer_phone" ||
    pendingStepKey === "offer_booking_sms"
  );
}

export function guardRealtimeUserTranscript(params: {
  transcript: string;
  realtimeState: CallState;
}): RealtimeTranscriptGuardResult {
  const { transcript, realtimeState } = params;

  const normalizedTranscript = normalizeForTranscriptGuard(transcript);
  const wordCount = getWordCount(transcript);

  const state = realtimeState as any;

  const bookingTurnStatus = clean(state.bookingTurnStatus);
  const pendingBookingStepKey = clean(state.pendingBookingStepKey);
  const pendingBookingStepPrompt = normalizeForTranscriptGuard(
    state.pendingBookingStepPrompt ?? ""
  );

  const activeResponseId = clean(state.activeResponseId ?? "");
  const assistantIsSpeaking = Boolean(activeResponseId);

  if (!normalizedTranscript) {
    return { ok: false, reason: "EMPTY_TRANSCRIPT" };
  }

  if (
    pendingBookingStepPrompt &&
    normalizedTranscript === pendingBookingStepPrompt
  ) {
    return { ok: false, reason: "MATCHES_PENDING_ASSISTANT_PROMPT" };
  }

  const allowShortBookingAnswerDuringAssistantAudio =
    assistantIsSpeaking &&
    bookingTurnStatus !== "waiting_user_answer" &&
    pendingBookingStepKey &&
    isShortBookingAnswerAllowed({
      state,
      wordCount,
    });

  if (allowShortBookingAnswerDuringAssistantAudio) {
    return { ok: true, reason: "ACCEPTED" };
  }

  if (
    assistantIsSpeaking &&
    bookingTurnStatus !== "waiting_user_answer" &&
    pendingBookingStepKey
  ) {
    return { ok: false, reason: "ASSISTANT_AUDIO_ACTIVE_BEFORE_USER_TURN" };
  }

  if (
    assistantIsSpeaking &&
    bookingTurnStatus !== "waiting_user_answer" &&
    wordCount <= 3
  ) {
    return { ok: false, reason: "SHORT_TRANSCRIPT_DURING_ASSISTANT_AUDIO" };
  }

  return { ok: true, reason: "ACCEPTED" };
}