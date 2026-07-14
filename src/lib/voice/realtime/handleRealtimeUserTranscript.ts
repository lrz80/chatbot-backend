// src/lib/voice/realtime/handleRealtimeUserTranscript.ts

import WebSocket from "ws";
import type { CallState, VoiceLocale } from "../types";
import { handleUserTranscriptCompleted } from "./realtimeTranscriptRuntime";

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
  dashboardUserContent?: string;
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

  if (aTokens.size === 0 || bTokens.size === 0) {
    return 0;
  }

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

  if (!transcript || !assistant) {
    return false;
  }

  if (transcript === assistant) {
    return true;
  }

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

  if (!letters || letters.length === 0) {
    return 0;
  }

  return new Set(letters).size / letters.length;
}

function isLikelyNoiseTranscript(params: {
  transcript: string;
  allowLowVarietyHeuristic: boolean;
}): boolean {
  const cleaned = clean(params.transcript);

  if (!cleaned) {
    return true;
  }

  const letters = letterCount(cleaned);
  const digits = digitCount(cleaned);
  const chars = normalizedCharCount(cleaned);

  if (chars <= 1) {
    return true;
  }

  if (letters === 0 && digits === 0) {
    return true;
  }

  /**
   * Esta heurística solo se aplica fuera de un booking step activo.
   *
   * Dentro del booking, respuestas como nombres, fechas, teléfonos,
   * direcciones o confirmaciones pueden tener poca variedad de caracteres
   * y aun así ser completamente válidas.
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
 * Este guard es completamente independiente del idioma.
 *
 * No se deben agregar frases específicas en español, inglés, portugués
 * ni ningún otro idioma. Aquí solo se decide si la transcripción puede
 * representar audio humano real.
 *
 * La interpretación del significado pertenece a los resolvers del booking.
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
   * Son steps cortos en los que el cliente frecuentemente responde
   * antes de que Aamy termine por completo el prompt.
   *
   * Este guard no interpreta la respuesta. Solo permite que llegue
   * al validador correspondiente.
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
  const bookingTurnStatus = clean(params.bookingTurnStatus);
  const pendingBookingStepKey = clean(params.pendingBookingStepKey);

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

  const hasPendingBookingStep = Boolean(pendingBookingStepKey);

  const canAcceptEarlyAnswer = canAcceptEarlyBookingAnswer({
    bookingTurnStatus,
    pendingBookingStepKey,
    transcript,
  });

  const isWaitingForBookingAnswer =
    hasPendingBookingStep && canAcceptEarlyAnswer;

  /**
   * Si existe un step pendiente, pero el sistema todavía no está preparado
   * para aceptar respuestas, se bloquea la transcripción.
   *
   * Las excepciones se limitan a los steps explícitamente definidos en
   * canAcceptEarlyBookingAnswer.
   */
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

  if (
    isLikelyNoiseTranscript({
      transcript,
      allowLowVarietyHeuristic: !isWaitingForBookingAnswer,
    })
  ) {
    return {
      ignore: true,
      interruptAssistant: false,
      reason: "NOISE_LIKE_TRANSCRIPT",
      msSinceAssistantAudioDone: null,
    };
  }

  const likelyAssistantEcho = isLikelyAssistantEcho({
    transcript,
    lastAssistantTranscript: params.lastAssistantTranscript,
  });

  /**
   * Mientras Aamy está hablando:
   *
   * - En un booking step no aceptamos respuestas todavía, porque podría ser
   *   eco del prompt o audio mezclado.
   * - Fuera del booking, una frase distinta al mensaje de Aamy puede ser una
   *   interrupción real del cliente y debe cancelar el audio del asistente.
   * - Si el texto coincide con el mensaje de Aamy, se considera eco.
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

    if (likelyAssistantEcho) {
      return {
        ignore: true,
        interruptAssistant: false,
        reason: "ASSISTANT_ECHO",
        msSinceAssistantAudioDone: null,
      };
    }

    return {
      ignore: false,
      interruptAssistant: true,
      msSinceAssistantAudioDone: null,
    };
  }

  /**
   * Un timestamp ausente o inválido no demuestra que la transcripción
   * sea eco. En ese caso se permite pasar al runtime.
   */
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

  const msSinceAssistantAudioDone = Math.max(
    0,
    nowMs() - lastAssistantAudioDoneAtMs
  );

  /**
   * La ventana para detectar eco debe ser temporal y corta.
   *
   * Fuera de esta ventana, una coincidencia textual no es suficiente
   * para descartar la frase del cliente.
   */
  const echoWindowMs = Math.max(
    params.minMsAfterAssistantAudio,
    1200
  );

  const isInsideEchoWindow =
    msSinceAssistantAudioDone < echoWindowMs;

  if (
    !isWaitingForBookingAnswer &&
    isInsideEchoWindow &&
    likelyAssistantEcho
  ) {
    return {
      ignore: true,
      interruptAssistant: false,
      reason: "ASSISTANT_ECHO",
      msSinceAssistantAudioDone,
    };
  }

  /**
   * En un booking step activo se permite la transcripción aunque llegue
   * cerca del final del audio.
   *
   * El validador del step decidirá si es:
   * - una respuesta válida;
   * - una respuesta ambigua;
   * - o texto que requiere repetir el prompt.
   *
   * No se debe perder silenciosamente una respuesta válida del cliente.
   */
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
   * True mientras OpenAI está generando audio del asistente.
   */
  assistantSpeaking: boolean;

  /**
   * Timestamp del último evento final de audio de Aamy.
   */
  lastAssistantAudioDoneAtMs: number;

  lastAssistantTranscript?: string | null;

  /**
   * Ventana mínima configurable después del audio de Aamy.
   */
  minMsAfterAssistantAudio?: number;
}): Promise<HandleRealtimeUserTranscriptResult> {
  const rawTranscript = clean(params.event?.transcript);

  const minMsAfterAssistantAudio =
    typeof params.minMsAfterAssistantAudio === "number" &&
    Number.isFinite(params.minMsAfterAssistantAudio) &&
    params.minMsAfterAssistantAudio >= 0
      ? params.minMsAfterAssistantAudio
      : 900;

  const preGuard = shouldIgnoreTranscriptBeforeRuntime({
    callEnding: params.callEnding,
    rawTranscript,
    assistantSpeaking: params.assistantSpeaking,
    lastAssistantAudioDoneAtMs: params.lastAssistantAudioDoneAtMs,
    minMsAfterAssistantAudio,
    bookingTurnStatus: clean(
      (params.realtimeState as any)?.bookingTurnStatus
    ),
    pendingBookingStepKey: clean(
      (params.realtimeState as any)?.pendingBookingStepKey
    ),
    lastAssistantTranscript: params.lastAssistantTranscript,
  });

  if (preGuard.ignore) {
    console.warn("[VOICE_REALTIME][USER_TRANSCRIPT_IGNORED]", {
      callSid: params.callSid,
      reason: preGuard.reason,
      transcript: rawTranscript,
      assistantSpeaking: params.assistantSpeaking,
      lastAssistantAudioDoneAtMs:
        finiteNumber(params.lastAssistantAudioDoneAtMs, 0) > 0
          ? params.lastAssistantAudioDoneAtMs
          : null,
      msSinceAssistantAudioDone:
        preGuard.msSinceAssistantAudioDone,
      minMsAfterAssistantAudio,
      bookingTurnStatus: clean(
        (params.realtimeState as any)?.bookingTurnStatus
      ),
      pendingBookingStepKey: clean(
        (params.realtimeState as any)?.pendingBookingStepKey
      ),
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
    dashboardUserContent: runtimeResult.dashboardUserContent,
  };
}