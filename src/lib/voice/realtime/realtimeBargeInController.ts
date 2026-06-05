// src/lib/voice/realtime/realtimeBargeInController.ts
import WebSocket from "ws";

type RealtimeResponseControllerLike = {
  getState: () => {
    activeResponseId?: string | null;
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
};

const MIN_MS_AFTER_ASSISTANT_AUDIO_TO_ALLOW_BARGE_IN = 650;
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

    const msSinceLastAssistantAudio =
      lastAssistantAudioDeltaAtMs > 0
        ? now - lastAssistantAudioDeltaAtMs
        : null;

    /**
     * Regla principal:
     * Si no hay respuesta activa y Aamy no está hablando, no hay nada que cortar.
     *
     * Antes se cortaba por "audio reciente" aunque activeResponseId fuera null
     * y assistantSpeaking fuera false. Eso mandaba Twilio clear sin razón.
     */
    if (!activeResponseId && !assistantSpeaking) {
      console.log("[VOICE_REALTIME][BARGE_IN_IGNORED_NO_ACTIVE_ASSISTANT_OUTPUT]", {
        callSid: params.getCallSid(),
        streamSid: params.getStreamSid(),
        source,
        activeResponseId: null,
        assistantSpeaking,
        msSinceLastAssistantAudio,
      });

      return false;
    }

    /**
     * No cortes a Aamy justo cuando empieza a hablar.
     * Esto evita que eco/ruido/input_audio_buffer.speech_started corte el prompt.
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
  }

  return {
    interruptAssistantAudio,
    wasRecentlyInterrupted,
    reset,
  };
}