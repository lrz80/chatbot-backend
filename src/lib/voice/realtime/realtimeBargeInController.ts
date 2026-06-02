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
  interruptAssistantAudio: (source: string) => void;
  reset: () => void;
} {
  let lastBargeInAtMs = 0;

  function interruptAssistantAudio(source: string): void {
    if (params.getCallEnding()) return;

    const now = Date.now();

    // Evita ráfagas repetidas de cancel/clear por el mismo corte.
    if (now - lastBargeInAtMs < 300) {
      return;
    }

    const responseState = params.responseController.getState();
    const activeResponseId = clean(responseState.activeResponseId);
    const lastAssistantAudioDeltaAtMs = params.getLastAssistantAudioDeltaAtMs();

    const hasAssistantAudioRecently =
      params.getAssistantSpeaking() ||
      (lastAssistantAudioDeltaAtMs > 0 &&
        now - lastAssistantAudioDeltaAtMs < 1500);

    if (!hasAssistantAudioRecently && !activeResponseId) {
      return;
    }

    lastBargeInAtMs = now;

    const callSid = params.getCallSid();
    const streamSid = params.getStreamSid();

    console.log("[VOICE_REALTIME][BARGE_IN_CLEAR_ASSISTANT_AUDIO]", {
      callSid,
      streamSid,
      source,
      activeResponseId: activeResponseId || null,
      assistantSpeaking: params.getAssistantSpeaking(),
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
  }

  function reset(): void {
    lastBargeInAtMs = 0;
  }

  return {
    interruptAssistantAudio,
    reset,
  };
}