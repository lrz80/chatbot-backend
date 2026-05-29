//src/lib/voice/realtime/transcriptGuards/guardRealtimeUserTranscript.ts
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

export function guardRealtimeUserTranscript(params: {
  transcript: string;
  realtimeState: CallState;
}): RealtimeTranscriptGuardResult {
  const { transcript, realtimeState } = params;

  const normalizedTranscript = normalizeForTranscriptGuard(transcript);
  const wordCount = getWordCount(transcript);

  const state = realtimeState as any;

  const bookingTurnStatus = String(state.bookingTurnStatus ?? "");
  const pendingBookingStepKey = String(state.pendingBookingStepKey ?? "");
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