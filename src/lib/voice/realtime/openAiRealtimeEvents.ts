// src/lib/voice/realtime/openAiRealtimeEvents.ts
import WebSocket from "ws";

export function safeJsonParseRealtimeEvent(value: WebSocket.RawData): any | null {
  try {
    return JSON.parse(value.toString());
  } catch {
    return null;
  }
}

export function getOpenAiRealtimeUrl(model: string): string {
  return `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
}

export function isConversationAlreadyHasActiveResponseError(event: any): boolean {
  return (
    event?.type === "error" &&
    event?.error?.code === "conversation_already_has_active_response"
  );
}

export function isResponseCancelNotActiveError(event: any): boolean {
  return (
    event?.type === "error" &&
    event?.error?.code === "response_cancel_not_active"
  );
}

export function resolveOpenAiRealtimeAudioDelta(event: any): string | null {
  if (
    typeof event?.delta === "string" &&
    (event.type === "response.audio.delta" ||
      event.type === "response.output_audio.delta")
  ) {
    return event.delta;
  }

  return null;
}

export function resolveOpenAiRealtimeAssistantTranscriptDelta(
  event: any
): string | null {
  if (
    typeof event?.delta === "string" &&
    (event.type === "response.audio_transcript.delta" ||
      event.type === "response.output_audio_transcript.delta")
  ) {
    return event.delta;
  }

  if (
    typeof event?.transcript === "string" &&
    (event.type === "response.audio_transcript.delta" ||
      event.type === "response.output_audio_transcript.delta")
  ) {
    return event.transcript;
  }

  return null;
}

export function resolveOpenAiRealtimeAssistantTranscriptDone(
  event: any
): string | null {
  if (
    typeof event?.transcript === "string" &&
    (event.type === "response.audio_transcript.done" ||
      event.type === "response.output_audio_transcript.done")
  ) {
    return event.transcript.trim();
  }

  return null;
}

export function isOpenAiRealtimeAssistantTranscriptDone(event: any): boolean {
  return (
    event?.type === "response.audio_transcript.done" ||
    event?.type === "response.output_audio_transcript.done"
  );
}