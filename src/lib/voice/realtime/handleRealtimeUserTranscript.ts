// src/lib/voice/realtime/handleRealtimeUserTranscript.ts
import WebSocket from "ws";
import type { CallState } from "../types";
import { handleUserTranscriptCompleted } from "./realtimeTranscriptRuntime";

type VoiceLocale = "en-US" | "es-ES" | "pt-BR";

export type HandleRealtimeUserTranscriptResult = {
  consumed: boolean;
  ignoredReason?:
    | "CALL_ENDING"
    | "EMPTY_TRANSCRIPT"
    | "ASSISTANT_AUDIO_ACTIVE"
    | "TOO_CLOSE_TO_ASSISTANT_AUDIO"
    | "NOISE_LIKE_TRANSCRIPT"
    | "RUNTIME_NOT_CONSUMED";
  lastUserTranscript: string;
  lastUserTranscriptSeq: number;
  currentLocale: VoiceLocale;
  realtimeState: CallState;
  realtimeTenant: any;
  realtimeCfg: any;
  localeLocked: boolean;
  tenantId: string | null;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

function nowMs(): number {
  return Date.now();
}

function normalizedCharCount(value: string): number {
  return clean(value).replace(/\s+/g, "").length;
}

function letterCount(value: string): number {
  const matches = clean(value).match(/\p{L}/gu);
  return matches ? matches.length : 0;
}

function digitCount(value: string): number {
  const matches = clean(value).match(/\p{N}/gu);
  return matches ? matches.length : 0;
}

function uniqueLetterRatio(value: string): number {
  const letters = clean(value)
    .toLowerCase()
    .match(/\p{L}/gu);

  if (!letters || letters.length === 0) return 0;

  return new Set(letters).size / letters.length;
}

function isLikelyNoiseTranscript(transcript: string): boolean {
  const cleaned = clean(transcript);

  if (!cleaned) return true;

  const letters = letterCount(cleaned);
  const digits = digitCount(cleaned);
  const chars = normalizedCharCount(cleaned);

  if (chars <= 1) return true;

  if (letters === 0 && digits === 0) return true;

  /**
   * Texto largo con poquísima variedad de letras suele ser ruido/transcripción mala.
   * Esta regla es agnóstica al idioma y no depende del negocio.
   */
  if (letters >= 6 && uniqueLetterRatio(cleaned) < 0.28) {
    return true;
  }

  return false;
}

function isOpenSocket(socket: WebSocket): boolean {
  return socket.readyState === WebSocket.OPEN;
}

function cancelActiveAssistantAudio(params: {
  openAiSocket: WebSocket;
  callSid: string | null;
  transcript: string;
}): void {
  if (!isOpenSocket(params.openAiSocket)) {
    console.warn("[VOICE_REALTIME][ASSISTANT_INTERRUPT_CANCEL_SKIPPED]", {
      callSid: params.callSid,
      reason: "OPENAI_SOCKET_NOT_OPEN",
      transcript: params.transcript,
      readyState: params.openAiSocket.readyState,
    });

    return;
  }

  try {
    params.openAiSocket.send(
      JSON.stringify({
        type: "response.cancel",
      })
    );

    console.log("[VOICE_REALTIME][ASSISTANT_INTERRUPTED_BY_USER_TRANSCRIPT]", {
      callSid: params.callSid,
      transcript: params.transcript,
    });
  } catch (error) {
    console.error("[VOICE_REALTIME][ASSISTANT_INTERRUPT_CANCEL_ERROR]", {
      callSid: params.callSid,
      transcript: params.transcript,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * This guard is intentionally language-agnostic.
 *
 * Do not add Spanish/English/Portuguese phrases here.
 * This layer only decides whether the transcript is safe to accept as human input.
 * Meaning/intent/slot validation belongs to booking/service resolvers.
 */
function shouldIgnoreTranscriptBeforeRuntime(params: {
  callEnding: boolean;
  rawTranscript: string;
  assistantSpeaking: boolean;
  lastAssistantAudioDoneAtMs: number;
  minMsAfterAssistantAudio: number;
  bookingTurnStatus: string;
  pendingBookingStepKey: string;
}): {
  ignore: boolean;
  interruptAssistant: boolean;
  reason?:
    | "CALL_ENDING"
    | "EMPTY_TRANSCRIPT"
    | "ASSISTANT_AUDIO_ACTIVE"
    | "TOO_CLOSE_TO_ASSISTANT_AUDIO"
    | "NOISE_LIKE_TRANSCRIPT";
  msSinceAssistantAudioDone: number | null;
} {
  const transcript = clean(params.rawTranscript);

  if (params.callEnding) {
    return {
      ignore: true,
      interruptAssistant: false,
      reason: "CALL_ENDING",
      msSinceAssistantAudioDone: null,
    };
  }

  if (!transcript) {
    return {
      ignore: true,
      interruptAssistant: false,
      reason: "EMPTY_TRANSCRIPT",
      msSinceAssistantAudioDone: null,
    };
  }

  if (isLikelyNoiseTranscript(transcript)) {
    return {
      ignore: true,
      interruptAssistant: false,
      reason: "NOISE_LIKE_TRANSCRIPT",
      msSinceAssistantAudioDone: null,
    };
  }

  const isWaitingForBookingAnswer =
    clean(params.bookingTurnStatus) === "waiting_user_answer" &&
    !!clean(params.pendingBookingStepKey);

  /**
   * En booking NO debemos aceptar cualquier transcript mientras Aamy habla.
   * Short answers can be valid after a direct question,
   * but they should not interrupt assistant audio.
   * pero deben entrar cuando el audio de Aamy ya terminó.
   *
   * Si el cliente realmente interrumpe mientras Aamy habla, exigimos una señal humana fuerte.
   * Esto evita que brisa/eco/ruido avance steps.
   */
  if (params.assistantSpeaking) {
    return {
      ignore: true,
      interruptAssistant: false,
      reason: "ASSISTANT_AUDIO_ACTIVE",
      msSinceAssistantAudioDone: null,
    };
  }

  const lastAssistantAudioDoneAtMs = finiteNumber(
    params.lastAssistantAudioDoneAtMs,
    0
  );

  if (lastAssistantAudioDoneAtMs <= 0) {
    return {
      ignore: false,
      interruptAssistant: false,
      msSinceAssistantAudioDone: null,
    };
  }

  const msSinceAssistantAudioDone = nowMs() - lastAssistantAudioDoneAtMs;

  const effectiveMinMsAfterAssistantAudio = isWaitingForBookingAnswer
    ? Math.max(params.minMsAfterAssistantAudio, 1500)
    : params.minMsAfterAssistantAudio;

  if (msSinceAssistantAudioDone < effectiveMinMsAfterAssistantAudio) {
    return {
      ignore: true,
      interruptAssistant: false,
      reason: "TOO_CLOSE_TO_ASSISTANT_AUDIO",
      msSinceAssistantAudioDone,
    };
  }

  return {
    ignore: false,
    interruptAssistant: false,
    msSinceAssistantAudioDone,
  };
}

export async function handleRealtimeUserTranscript(params: {
  event: any;
  callSid: string | null;
  didNumber: string | null;
  model: string;
  currentLocale: VoiceLocale;
  realtimeState: CallState;
  realtimeTenant: any;
  realtimeCfg: any;
  localeLocked: boolean;
  lastUserTranscriptSeq: number;
  refreshRealtimeVoiceContext: any;
  refreshRealtimeSession: any;
  openAiSocket: WebSocket;
  tenantId: string | null;
  callEnding: boolean;

  /**
   * True while OpenAI is producing assistant audio.
   * This prevents assistant echo from being accepted as user input.
   */
  assistantSpeaking: boolean;

  /**
   * Timestamp from response.done or final audio event.
   * Used as a short grace window after Aamy finishes speaking.
   */
  lastAssistantAudioDoneAtMs: number;

  /**
   * Production default: 700–1200ms.
   * Keep configurable from bridge so tenants/calls can be tuned later.
   */
  minMsAfterAssistantAudio?: number;
}): Promise<HandleRealtimeUserTranscriptResult> {
  const rawTranscript = clean(params.event?.transcript);

  const minMsAfterAssistantAudio =
    typeof params.minMsAfterAssistantAudio === "number" &&
    Number.isFinite(params.minMsAfterAssistantAudio)
      ? params.minMsAfterAssistantAudio
      : 900;

  const preGuard = shouldIgnoreTranscriptBeforeRuntime({
    callEnding: params.callEnding,
    rawTranscript,
    assistantSpeaking: params.assistantSpeaking,
    lastAssistantAudioDoneAtMs: params.lastAssistantAudioDoneAtMs,
    minMsAfterAssistantAudio,
    bookingTurnStatus: clean((params.realtimeState as any)?.bookingTurnStatus),
    pendingBookingStepKey: clean(
      (params.realtimeState as any)?.pendingBookingStepKey
    ),
  });

  if (preGuard.ignore) {
    console.warn("[VOICE_REALTIME][USER_TRANSCRIPT_IGNORED]", {
      callSid: params.callSid,
      reason: preGuard.reason,
      transcript: rawTranscript,
      assistantSpeaking: params.assistantSpeaking,
      lastAssistantAudioDoneAtMs: params.lastAssistantAudioDoneAtMs || null,
      msSinceAssistantAudioDone: preGuard.msSinceAssistantAudioDone,
      minMsAfterAssistantAudio,
    });

    return {
      consumed: false,
      ignoredReason: preGuard.reason,
      lastUserTranscript: "",
      lastUserTranscriptSeq: params.lastUserTranscriptSeq,
      currentLocale: params.currentLocale,
      realtimeState: params.realtimeState,
      realtimeTenant: params.realtimeTenant,
      realtimeCfg: params.realtimeCfg,
      localeLocked: params.localeLocked,
      tenantId: params.tenantId,
    };
  }

  const runtimeResult = await handleUserTranscriptCompleted({
    event: params.event,
    callSid: params.callSid,
    didNumber: params.didNumber,
    model: params.model,
    currentLocale: params.currentLocale,
    realtimeState: params.realtimeState,
    realtimeTenant: params.realtimeTenant,
    realtimeCfg: params.realtimeCfg,
    localeLocked: params.localeLocked,
    lastUserTranscriptSeq: params.lastUserTranscriptSeq,
    refreshRealtimeVoiceContext: params.refreshRealtimeVoiceContext,
    refreshRealtimeSession: params.refreshRealtimeSession,
    openAiSocket: params.openAiSocket,
    tenantId: params.tenantId,
  });

  if (!runtimeResult.consumed) {
    return {
      consumed: false,
      ignoredReason: "RUNTIME_NOT_CONSUMED",
      lastUserTranscript: "",
      lastUserTranscriptSeq: params.lastUserTranscriptSeq,
      currentLocale: params.currentLocale,
      realtimeState: params.realtimeState,
      realtimeTenant: params.realtimeTenant,
      realtimeCfg: params.realtimeCfg,
      localeLocked: params.localeLocked,
      tenantId: params.tenantId,
    };
  }

  if (preGuard.interruptAssistant) {
    cancelActiveAssistantAudio({
      openAiSocket: params.openAiSocket,
      callSid: params.callSid,
      transcript: rawTranscript,
    });
  }

  console.log("[VOICE_REALTIME][USER_TRANSCRIPT_ACCEPTED]", {
    callSid: params.callSid,
    transcript: runtimeResult.lastUserTranscript,
    lastUserTranscriptSeq: runtimeResult.lastUserTranscriptSeq,
    currentLocale: runtimeResult.currentLocale,
    bookingTurnStatus: (runtimeResult.realtimeState as any).bookingTurnStatus || "",
    pendingBookingStepKey: runtimeResult.realtimeState.pendingBookingStepKey || "",
    pendingBookingStepPromptAnchorSeq:
      typeof runtimeResult.realtimeState.pendingBookingStepPromptAnchorSeq === "number"
        ? runtimeResult.realtimeState.pendingBookingStepPromptAnchorSeq
        : null,
    });

  return {
    consumed: true,
    lastUserTranscript: runtimeResult.lastUserTranscript,
    lastUserTranscriptSeq: runtimeResult.lastUserTranscriptSeq,
    currentLocale: runtimeResult.currentLocale,
    realtimeState: runtimeResult.realtimeState,
    realtimeTenant: runtimeResult.realtimeTenant,
    realtimeCfg: runtimeResult.realtimeCfg,
    localeLocked: runtimeResult.localeLocked,
    tenantId: runtimeResult.tenantId,
  };
}