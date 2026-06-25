// src/lib/voice/realtime/realtimeBargeInController.ts
import WebSocket from "ws";

type RealtimeResponseControllerLike = {
  getState: () => {
    activeResponseId?: string | null;
    activeResponseStartedAtMs?: number | null;
    activeResponseCreatedAtMs?: number | null;
  };
};

type RealtimeBargeInControllerParams = {
  openAiSocket: WebSocket;
  twilioSocket: WebSocket;
  responseController: RealtimeResponseControllerLike;
  getCallSid: () => string | null;
  getStreamSid: () => string | null;
  getCallEnding: () => boolean;
  getAssistantSpeaking: () => boolean;
  setAssistantSpeaking: (value: boolean) => void;
  getLastAssistantAudioDeltaAtMs: () => number;
  setLastAssistantAudioDoneAtMs: (value: number) => void;

  /**
   * Optional booking state getters.
   * They keep this controller generic and avoid hardcoding business logic.
   */
  getBookingTurnStatus?: () => string | null;
  getPendingBookingStepKey?: () => string | null;
};

const MIN_MS_AFTER_ASSISTANT_AUDIO_TO_ALLOW_BARGE_IN = 650;
const MIN_MS_AFTER_ACTIVE_RESPONSE_START_TO_ALLOW_BARGE_IN = 1200;
const MIN_MS_AFTER_BOOKING_PROMPT_START_TO_ALLOW_BARGE_IN = 1500;
const BARGE_IN_DEBOUNCE_MS = 300;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

export function createRealtimeBargeInController(
  params: RealtimeBargeInControllerParams
): {
  interruptAssistantAudio: (source: string) => boolean;
  wasRecentlyInterrupted: (windowMs?: number) => boolean;
  reset: () => void;
} {
  let lastBargeInAtMs = 0;
  let observedActiveResponseId = "";
  let observedActiveResponseStartedAtMs = 0;

  function getActiveResponseAgeMs(params: {
    activeResponseId: string;
    responseStartedAtMs: number | null;
    now: number;
  }): number | null {
    const { activeResponseId, responseStartedAtMs, now } = params;

    if (!activeResponseId) {
      observedActiveResponseId = "";
      observedActiveResponseStartedAtMs = 0;
      return null;
    }

    /**
     * Prefer the response controller timestamp if available.
     * Fallback to first time this barge-in controller observes the active response.
     */
    if (responseStartedAtMs && responseStartedAtMs > 0) {
      observedActiveResponseId = activeResponseId;
      observedActiveResponseStartedAtMs = responseStartedAtMs;
      return now - responseStartedAtMs;
    }

    if (observedActiveResponseId !== activeResponseId) {
      observedActiveResponseId = activeResponseId;
      observedActiveResponseStartedAtMs = now;
    }

    return now - observedActiveResponseStartedAtMs;
  }

  function interruptAssistantAudio(source: string): boolean {
    if (params.getCallEnding()) {
      return false;
    }

    const now = Date.now();

    if (now - lastBargeInAtMs < BARGE_IN_DEBOUNCE_MS) {
      return false;
    }

    const responseState = params.responseController.getState();
    const activeResponseId = clean(responseState.activeResponseId);
    const assistantSpeaking = params.getAssistantSpeaking();
    const lastAssistantAudioDeltaAtMs = params.getLastAssistantAudioDeltaAtMs();

    const responseStartedAtMs =
      typeof responseState.activeResponseStartedAtMs === "number" &&
      responseState.activeResponseStartedAtMs > 0
        ? responseState.activeResponseStartedAtMs
        : typeof responseState.activeResponseCreatedAtMs === "number" &&
            responseState.activeResponseCreatedAtMs > 0
          ? responseState.activeResponseCreatedAtMs
          : null;

    const activeResponseAgeMs = getActiveResponseAgeMs({
      activeResponseId,
      responseStartedAtMs,
      now,
    });

    const msSinceLastAssistantAudio =
      lastAssistantAudioDeltaAtMs > 0
        ? now - lastAssistantAudioDeltaAtMs
        : null;

    const bookingTurnStatus = clean(params.getBookingTurnStatus?.());
    const pendingBookingStepKey = clean(params.getPendingBookingStepKey?.());

    const isBookingPromptBeingSpoken =
      Boolean(pendingBookingStepKey) &&
      bookingTurnStatus === "waiting_assistant_prompt";

    /**
     * Regla principal:
     * Si no hay respuesta activa y Aamy no está hablando, no hay nada que cortar.
     */
    if (!activeResponseId && !assistantSpeaking) {
      console.log("[VOICE_REALTIME][BARGE_IN_IGNORED_NO_ACTIVE_ASSISTANT_OUTPUT]", {
        callSid: params.getCallSid(),
        streamSid: params.getStreamSid(),
        source,
        activeResponseId: null,
        assistantSpeaking,
        msSinceLastAssistantAudio,
        activeResponseAgeMs,
        bookingTurnStatus,
        pendingBookingStepKey,
      });

      return false;
    }

    /**
     * Protección general:
     * No cortes una respuesta apenas comienza.
     *
     * Esto evita que ruido, eco o speech_started prematuro corten el primer prompt.
     */
    const isTooSoonAfterActiveResponseStart =
      activeResponseAgeMs !== null &&
      activeResponseAgeMs < MIN_MS_AFTER_ACTIVE_RESPONSE_START_TO_ALLOW_BARGE_IN;

    if (isTooSoonAfterActiveResponseStart) {
      console.log("[VOICE_REALTIME][BARGE_IN_IGNORED_TOO_SOON_AFTER_RESPONSE_START]", {
        callSid: params.getCallSid(),
        streamSid: params.getStreamSid(),
        source,
        activeResponseId: activeResponseId || null,
        assistantSpeaking,
        activeResponseAgeMs,
        minMsAfterActiveResponseStart:
          MIN_MS_AFTER_ACTIVE_RESPONSE_START_TO_ALLOW_BARGE_IN,
        bookingTurnStatus,
        pendingBookingStepKey,
      });

      return false;
    }

    /**
     * Protección especial para prompts del booking flow.
     *
     * No es hardcode por negocio ni por idioma.
     * Solo protege cualquier step activo del booking engine mientras el prompt se está hablando.
     */
    const isTooSoonDuringBookingPrompt =
      isBookingPromptBeingSpoken &&
      activeResponseAgeMs !== null &&
      activeResponseAgeMs < MIN_MS_AFTER_BOOKING_PROMPT_START_TO_ALLOW_BARGE_IN;

    if (isTooSoonDuringBookingPrompt) {
      console.log("[VOICE_REALTIME][BARGE_IN_IGNORED_DURING_BOOKING_PROMPT_START]", {
        callSid: params.getCallSid(),
        streamSid: params.getStreamSid(),
        source,
        activeResponseId: activeResponseId || null,
        assistantSpeaking,
        activeResponseAgeMs,
        minMsAfterBookingPromptStart:
          MIN_MS_AFTER_BOOKING_PROMPT_START_TO_ALLOW_BARGE_IN,
        bookingTurnStatus,
        pendingBookingStepKey,
      });

      return false;
    }

    /**
     * Protección por audio reciente.
     * Se mantiene, pero ya no depende exclusivamente de este timestamp.
     */
    const isTooSoonAfterAssistantAudio =
      msSinceLastAssistantAudio !== null &&
      msSinceLastAssistantAudio < MIN_MS_AFTER_ASSISTANT_AUDIO_TO_ALLOW_BARGE_IN;

    if (isTooSoonAfterAssistantAudio) {
      console.log("[VOICE_REALTIME][BARGE_IN_IGNORED_TOO_SOON_AFTER_ASSISTANT_AUDIO]", {
        callSid: params.getCallSid(),
        streamSid: params.getStreamSid(),
        source,
        activeResponseId: activeResponseId || null,
        assistantSpeaking,
        msSinceLastAssistantAudio,
        minMsAfterAssistantAudio:
          MIN_MS_AFTER_ASSISTANT_AUDIO_TO_ALLOW_BARGE_IN,
        activeResponseAgeMs,
        bookingTurnStatus,
        pendingBookingStepKey,
      });

      return false;
    }

    lastBargeInAtMs = now;

    const callSid = params.getCallSid();
    const streamSid = params.getStreamSid();

    console.log("[VOICE_REALTIME][BARGE_IN_CLEAR_ASSISTANT_AUDIO]", {
      callSid,
      streamSid,
      source,
      activeResponseId: activeResponseId || null,
      assistantSpeaking,
      msSinceLastAssistantAudio,
      activeResponseAgeMs,
      bookingTurnStatus,
      pendingBookingStepKey,
    });

    if (activeResponseId) {
      sendJson(params.openAiSocket, {
        type: "response.cancel",
        response_id: activeResponseId,
      });
    }

    if (streamSid) {
      sendJson(params.twilioSocket, {
        event: "clear",
        streamSid,
      });
    }

    params.setAssistantSpeaking(false);
    params.setLastAssistantAudioDoneAtMs(now);

    return true;
  }

  function wasRecentlyInterrupted(windowMs = 2500): boolean {
    if (lastBargeInAtMs <= 0) {
      return false;
    }

    return Date.now() - lastBargeInAtMs <= windowMs;
  }

  function reset(): void {
    lastBargeInAtMs = 0;
    observedActiveResponseId = "";
    observedActiveResponseStartedAtMs = 0;
  }

  return {
    interruptAssistantAudio,
    wasRecentlyInterrupted,
    reset,
  };
}