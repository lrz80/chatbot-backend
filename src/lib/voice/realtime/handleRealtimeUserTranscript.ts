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
    | "ASSISTANT_ECHO"
    | "TOO_CLOSE_TO_ASSISTANT_AUDIO"
    | "NOISE_LIKE_TRANSCRIPT"
    | "BOOKING_NOT_READY_FOR_USER_ANSWER"
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

function getPendingBookingStepExpectedType(realtimeState: CallState): string {
  return clean((realtimeState as any)?.pendingBookingStepExpectedType)
    .toLowerCase();
}

function getPendingBookingStepValidationMode(realtimeState: CallState): string {
  return clean(
    (realtimeState as any)?.pendingBookingStepValidationConfig?.mode
  ).toLowerCase();
}

function isShortSemanticBookingAnswerAllowed(params: {
  realtimeState: CallState;
  pendingBookingStepKey: string;
}): boolean {
  const expectedType = getPendingBookingStepExpectedType(params.realtimeState);
  const validationMode = getPendingBookingStepValidationMode(
    params.realtimeState
  );

  return (
    expectedType === "confirmation" ||
    validationMode === "confirm_or_replace"
  );
}

function normalizeForEchoComparison(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(value: string): Set<string> {
  return new Set(
    normalizeForEchoComparison(value)
      .split(/\s+/)
      .filter((token) => token.length >= 2)
  );
}

function tokenOverlapRatio(a: string, b: string): number {
  const aTokens = tokenSet(a);
  const bTokens = tokenSet(b);

  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let overlap = 0;

  for (const token of aTokens) {
    if (bTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap / Math.min(aTokens.size, bTokens.size);
}

function isLikelyAssistantEcho(params: {
  transcript: string;
  lastAssistantTranscript?: string | null;
}): boolean {
  const transcript = normalizeForEchoComparison(params.transcript);
  const assistant = normalizeForEchoComparison(params.lastAssistantTranscript);

  if (!transcript || !assistant) return false;

  if (transcript === assistant) return true;

  if (transcript.length >= 12 && assistant.includes(transcript)) {
    return true;
  }

  if (assistant.length >= 12 && transcript.includes(assistant)) {
    return true;
  }

  return tokenOverlapRatio(transcript, assistant) >= 0.75;
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

function isLikelyNoiseTranscript(params: {
  transcript: string;
  allowLowVarietyHeuristic: boolean;
  allowShortSemanticAnswer: boolean;
}): boolean {
  const cleaned = clean(params.transcript);

  if (!cleaned) return true;

  const letters = letterCount(cleaned);
  const digits = digitCount(cleaned);
  const chars = normalizedCharCount(cleaned);

  if (letters === 0 && digits === 0) return true;

  if (chars <= 1 && !params.allowShortSemanticAnswer) {
    return true;
  }

  /**
   * Esta heurística sirve para filtrar ruido fuera del booking flow.
   * Pero dentro de un booking step pendiente, una respuesta válida puede ser
   * una dirección, teléfono, nombre, peso o fecha con baja variedad de caracteres.
   */
  if (
    params.allowLowVarietyHeuristic &&
    letters >= 6 &&
    uniqueLetterRatio(cleaned) < 0.28
  ) {
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

function canAcceptEarlyBookingAnswer(params: {
  bookingTurnStatus: string;
  pendingBookingStepKey: string;
  transcript: string;
}): boolean {
  const bookingTurnStatus = clean(params.bookingTurnStatus);
  const pendingBookingStepKey = clean(params.pendingBookingStepKey);
  const transcript = clean(params.transcript);

  if (!pendingBookingStepKey || !transcript) {
    return false;
  }

  if (bookingTurnStatus === "waiting_user_answer") {
    return true;
  }

  if (bookingTurnStatus !== "waiting_assistant_prompt") {
    return false;
  }

  /**
   * These are short confirmation-style steps where callers commonly answer
   * while Aamy is still finishing the prompt.
   *
   * This guard does not decide the meaning of "sí", "no", etc.
   * It only allows the transcript to reach the booking validator.
   */
  const earlyAnswerAllowedSteps = new Set([
    "phone",
    "confirm",
    "offer_booking_sms",
  ]);

  return earlyAnswerAllowedSteps.has(pendingBookingStepKey);
}

function shouldIgnoreTranscriptBeforeRuntime(params: {
  callEnding: boolean;
  rawTranscript: string;
  assistantSpeaking: boolean;
  lastAssistantAudioDoneAtMs: number;
  minMsAfterAssistantAudio: number;
  bookingTurnStatus: string;
  pendingBookingStepKey: string;
  realtimeState: CallState;
  lastAssistantTranscript?: string | null;
}): {
  ignore: boolean;
  interruptAssistant: boolean;
  reason?:
    | "CALL_ENDING"
    | "EMPTY_TRANSCRIPT"
    | "ASSISTANT_AUDIO_ACTIVE"
    | "ASSISTANT_ECHO"
    | "TOO_CLOSE_TO_ASSISTANT_AUDIO"
    | "NOISE_LIKE_TRANSCRIPT"
    | "BOOKING_NOT_READY_FOR_USER_ANSWER";
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

  const isWaitingForBookingAnswer =
    !!clean(params.pendingBookingStepKey) &&
    canAcceptEarlyBookingAnswer({
      bookingTurnStatus: clean(params.bookingTurnStatus),
      pendingBookingStepKey: clean(params.pendingBookingStepKey),
      transcript,
    });

  const hasPendingBookingStep = !!clean(params.pendingBookingStepKey);

  const bookingTurnStatus = clean(params.bookingTurnStatus);

  /**
   * Si ya hay un step pendiente, pero el sistema todavía no abrió
   * formalmente el turno para escuchar al usuario, no aceptamos transcript.
   *
   * Esto evita que ruido/eco capturado mientras Aamy está cambiando de prompt
   * se convierta en respuesta del próximo step.
   */
  const canAcceptEarlyAnswer = canAcceptEarlyBookingAnswer({
    bookingTurnStatus,
    pendingBookingStepKey: params.pendingBookingStepKey,
    transcript,
  });

  if (
    hasPendingBookingStep &&
    bookingTurnStatus &&
    bookingTurnStatus !== "waiting_user_answer" &&
    !canAcceptEarlyAnswer
  ) {
    return {
      ignore: true,
      interruptAssistant: false,
      reason: "BOOKING_NOT_READY_FOR_USER_ANSWER",
      msSinceAssistantAudioDone: null,
    };
  }

  const allowShortSemanticAnswer =
    isWaitingForBookingAnswer &&
    isShortSemanticBookingAnswerAllowed({
      realtimeState: params.realtimeState,
      pendingBookingStepKey: clean(params.pendingBookingStepKey),
    });

  if (
    isLikelyNoiseTranscript({
      transcript,
      allowLowVarietyHeuristic: !isWaitingForBookingAnswer,
      allowShortSemanticAnswer,
    })
  ) {
    return {
      ignore: true,
      interruptAssistant: false,
      reason: "NOISE_LIKE_TRANSCRIPT",
      msSinceAssistantAudioDone: null,
    };
  }

  if (
    isLikelyAssistantEcho({
      transcript,
      lastAssistantTranscript: params.lastAssistantTranscript,
    })
  ) {
    return {
      ignore: true,
      interruptAssistant: false,
      reason: "ASSISTANT_ECHO",
      msSinceAssistantAudioDone: null,
    };
  }
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
    if (isWaitingForBookingAnswer) {
      return {
        ignore: true,
        interruptAssistant: false,
        reason: "ASSISTANT_AUDIO_ACTIVE",
        msSinceAssistantAudioDone: null,
      };
    }

    return {
      ignore: false,
      interruptAssistant: true,
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
    if (
      isLikelyAssistantEcho({
        transcript,
        lastAssistantTranscript: params.lastAssistantTranscript,
      })
    ) {
      return {
        ignore: true,
        interruptAssistant: false,
        reason: "ASSISTANT_ECHO",
        msSinceAssistantAudioDone,
      };
    }

    /**
     * En booking, cualquier transcript demasiado cerca del audio de Aamy
     * es de alto riesgo: eco, ruido, barge-in falso o corte de audio.
     * No debe alimentar lastUserTranscript ni avanzar steps.
     */
    if (isWaitingForBookingAnswer) {
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
  lastAssistantTranscript?: string | null;

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
    realtimeState: params.realtimeState,
    lastAssistantTranscript: params.lastAssistantTranscript,
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

  if (preGuard.interruptAssistant) {
    cancelActiveAssistantAudio({
      openAiSocket: params.openAiSocket,
      callSid: params.callSid,
      transcript: rawTranscript,
    });
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