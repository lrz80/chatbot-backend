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

    /**
     * Evita ráfagas repetidas de cancel/clear por el mismo corte.
     * Esto protege contra eventos duplicados de speech_started/transcript_completed.
     */
    if (now - lastBargeInAtMs < 300) {
      return false;
    }

    const responseState = params.responseController.getState();
    const activeResponseId = clean(responseState.activeResponseId);
    const lastAssistantAudioDeltaAtMs = params.getLastAssistantAudioDeltaAtMs();

    const assistantSpeaking = params.getAssistantSpeaking();

    const hasAssistantAudioRecently =
      assistantSpeaking ||
      (lastAssistantAudioDeltaAtMs > 0 &&
        now - lastAssistantAudioDeltaAtMs < 1500);

    if (!hasAssistantAudioRecently && !activeResponseId) {
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
      msSinceLastAssistantAudio:
        lastAssistantAudioDeltaAtMs > 0
          ? now - lastAssistantAudioDeltaAtMs
          : null,
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