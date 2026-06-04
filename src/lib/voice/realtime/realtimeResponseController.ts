// src/lib/voice/realtime/realtimeResponseController.ts
import WebSocket from "ws";

type ResponseControllerParams = {
  openAiSocket: WebSocket;
  twilioSocket: WebSocket;
  getCallSid: () => string | null;
  getStreamSid: () => string | null;
};

type RequestRealtimeResponseParams = {
  event: Record<string, unknown>;
  source: string;
  shouldInterruptActiveResponse: boolean;
  startedAtUserTranscriptSeq: number;
};

type ResponseControllerState = {
  activeResponseId: string | null;
  activeResponseSource: string | null;
  activeResponseStartedAtUserTranscriptSeq: number;
  pendingResponseCreate: Record<string, unknown> | null;
  pendingResponseSource: string | null;
  awaitingResponseSource: string | null;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function shouldSupersedeActiveResponse(params: {
  source: string;
  shouldInterruptActiveResponse: boolean;
}): boolean {
  const source = clean(params.source);

  if (params.shouldInterruptActiveResponse) {
    return true;
  }

  /**
   * Tool followups are not casual assistant chatter.
   * They are runtime-controlled responses to a completed tool result.
   *
   * If they remain queued behind an active/stale response, the caller hears silence.
   * This is generic runtime policy, not tenant/business-specific logic.
   */
  return source.startsWith("tool_followup:");
}

function shouldSkipRedundantQueuedResponse(params: {
  source: string;
  activeResponseSource: string | null;
}): boolean {
  const source = clean(params.source);
  const activeSource = clean(params.activeResponseSource);

  return (
    source === "tool_guard:duplicate_stale_submit_force_current_step_prompt" &&
    activeSource === "tool_followup:submit_booking_step:synthetic_direct"
  );
}

export function createRealtimeResponseController(
  params: ResponseControllerParams
) {
  let activeResponseId: string | null = null;
  let activeResponseSource: string | null = null;
  let activeResponseStartedAtUserTranscriptSeq = 0;

  let pendingResponseCreate: Record<string, unknown> | null = null;
  let pendingResponseSource: string | null = null;

  let awaitingResponseSource: string | null = null;

  function getState(): ResponseControllerState {
    return {
      activeResponseId,
      activeResponseSource,
      activeResponseStartedAtUserTranscriptSeq,
      pendingResponseCreate,
      pendingResponseSource,
      awaitingResponseSource,
    };
  }

  function requestRealtimeResponse({
    event,
    source,
    shouldInterruptActiveResponse,
    startedAtUserTranscriptSeq,
  }: RequestRealtimeResponseParams): void {
    const callSid = params.getCallSid();
    const streamSid = params.getStreamSid();

    const shouldSupersede = shouldSupersedeActiveResponse({
      source,
      shouldInterruptActiveResponse,
    });

    if (activeResponseId) {
      if (
        shouldSkipRedundantQueuedResponse({
          source,
          activeResponseSource,
        })
      ) {
        console.warn("[VOICE_REALTIME][REDUNDANT_RESPONSE_CREATE_SKIPPED]", {
          callSid,
          source,
          activeResponseId,
          activeResponseSource,
          reason: "GUARD_PROMPT_ALREADY_COVERED_BY_SYNTHETIC_DIRECT",
        });

        return;
      }

      pendingResponseCreate = event;
      pendingResponseSource = source;

      console.warn("[VOICE_REALTIME][RESPONSE_CREATE_QUEUED]", {
        callSid,
        source,
        activeResponseId,
        activeResponseSource,
        shouldInterruptActiveResponse,
        shouldSupersede,
      });

      if (
        shouldSupersede &&
        params.openAiSocket.readyState === WebSocket.OPEN
      ) {
        console.warn("[VOICE_REALTIME][ACTIVE_RESPONSE_CANCEL_REQUESTED]", {
          callSid,
          activeResponseId,
          activeResponseSource,
          pendingResponseSource: source,
        });

        sendJson(params.openAiSocket, {
          type: "response.cancel",
        });

        if (streamSid && params.twilioSocket.readyState === WebSocket.OPEN) {
          sendJson(params.twilioSocket, {
            event: "clear",
            streamSid,
          });
        }
      }

      return;
    }

    activeResponseStartedAtUserTranscriptSeq = startedAtUserTranscriptSeq;
    awaitingResponseSource = source;

    console.warn("[VOICE_REALTIME][RESPONSE_CREATE_REQUESTED]", {
      callSid,
      source,
      startedAtUserTranscriptSeq,
      hasPendingResponseCreate: Boolean(pendingResponseCreate),
    });

    sendJson(params.openAiSocket, event);
  }

  function flushPendingRealtimeResponse(): boolean {
    if (!pendingResponseCreate) return false;
    if (activeResponseId) return false;
    if (params.openAiSocket.readyState !== WebSocket.OPEN) return false;

    const callSid = params.getCallSid();

    const event = pendingResponseCreate;
    const source = pendingResponseSource;

    pendingResponseCreate = null;
    pendingResponseSource = null;
    awaitingResponseSource = source;

    console.warn("[VOICE_REALTIME][PENDING_RESPONSE_CREATE_FLUSHED]", {
      callSid,
      source,
    });

    sendJson(params.openAiSocket, event);
    return true;
  }

  function markResponseCreated(paramsForResponse: {
    responseId: string | null;
    startedAtUserTranscriptSeq: number;
  }): ResponseControllerState {
    activeResponseId = paramsForResponse.responseId;
    activeResponseSource = awaitingResponseSource;
    activeResponseStartedAtUserTranscriptSeq =
      paramsForResponse.startedAtUserTranscriptSeq;
    awaitingResponseSource = null;

    return getState();
  }

  function markResponseDone(paramsForResponse: {
    lastUserTranscriptSeq: number;
  }): ResponseControllerState {
    activeResponseId = null;
    activeResponseSource = null;
    activeResponseStartedAtUserTranscriptSeq =
      paramsForResponse.lastUserTranscriptSeq;

    flushPendingRealtimeResponse();

    return getState();
  }

  function handleConversationAlreadyHasActiveResponseError(): void {
    const callSid = params.getCallSid();
    const streamSid = params.getStreamSid();

    console.warn("[VOICE_REALTIME][RESPONSE_ALREADY_ACTIVE_RETRY_QUEUED]", {
      callSid,
      activeResponseId,
      pendingResponseSource,
      hasPendingResponseCreate: Boolean(pendingResponseCreate),
    });

    if (!pendingResponseCreate) {
      return;
    }

    if (activeResponseId && params.openAiSocket.readyState === WebSocket.OPEN) {
      sendJson(params.openAiSocket, {
        type: "response.cancel",
      });

      if (streamSid && params.twilioSocket.readyState === WebSocket.OPEN) {
        sendJson(params.twilioSocket, {
          event: "clear",
          streamSid,
        });
      }

      return;
    }

    flushPendingRealtimeResponse();
  }

  function handleResponseCancelNotActiveError(): void {
    const callSid = params.getCallSid();

    console.warn("[VOICE_REALTIME][RESPONSE_CANCEL_NOT_ACTIVE_IGNORED]", {
      callSid,
      activeResponseId,
      pendingResponseSource,
    });

    activeResponseId = null;
    activeResponseSource = null;

    flushPendingRealtimeResponse();
  }

  return {
    getState,
    requestRealtimeResponse,
    flushPendingRealtimeResponse,
    markResponseCreated,
    markResponseDone,
    handleConversationAlreadyHasActiveResponseError,
    handleResponseCancelNotActiveError,
  };
}