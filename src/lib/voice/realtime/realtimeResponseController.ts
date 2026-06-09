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

type AwaitingResponseCreateState = {
  event: Record<string, unknown>;
  source: string;
  startedAtUserTranscriptSeq: number;
  retryCount: number;
};

const RESPONSE_CREATE_ACK_TIMEOUT_MS = 1200;
const MAX_RESPONSE_CREATE_RETRIES = 1;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function sendJson(socket: WebSocket, payload: Record<string, unknown>): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

function shouldSupersedeActiveResponse(params: {
  source: string;
  activeResponseSource: string | null;
  shouldInterruptActiveResponse: boolean;
}): boolean {
  const source = clean(params.source);

  if (params.shouldInterruptActiveResponse) {
    return true;
  }

  if (source.startsWith("tool_followup:")) {
    return true;
  }

  return false;
}

export function createRealtimeResponseController(
  params: ResponseControllerParams
) {
  let activeResponseId: string | null = null;
  let activeResponseSource: string | null = null;
  let activeResponseStartedAtUserTranscriptSeq = 0;

  let pendingResponseCreate: Record<string, unknown> | null = null;
  let pendingResponseSource: string | null = null;
  let pendingResponseStartedAtUserTranscriptSeq: number | null = null;

  let awaitingResponseSource: string | null = null;
  let awaitingResponseCreate: AwaitingResponseCreateState | null = null;
  let awaitingResponseCreateRetryTimer: ReturnType<typeof setTimeout> | null =
    null;

  function clearAwaitingResponseCreateRetryTimer(): void {
    if (!awaitingResponseCreateRetryTimer) return;
    clearTimeout(awaitingResponseCreateRetryTimer);
    awaitingResponseCreateRetryTimer = null;
  }

  function scheduleAwaitingResponseCreateRetry(): void {
    clearAwaitingResponseCreateRetryTimer();

    if (!awaitingResponseCreate) return;

    awaitingResponseCreateRetryTimer = setTimeout(() => {
      const callSid = params.getCallSid();

      if (!awaitingResponseCreate) return;
      if (activeResponseId) return;

      if (pendingResponseCreate) {
        return;
      }

      if (params.openAiSocket.readyState !== WebSocket.OPEN) {
        console.warn("[VOICE_REALTIME][RESPONSE_CREATE_RETRY_SOCKET_NOT_OPEN]", {
          callSid,
          source: awaitingResponseCreate.source,
          socketReadyState: params.openAiSocket.readyState,
        });
        return;
      }

      if (awaitingResponseCreate.retryCount >= MAX_RESPONSE_CREATE_RETRIES) {
        console.warn("[VOICE_REALTIME][RESPONSE_CREATE_ACK_TIMEOUT]", {
          callSid,
          source: awaitingResponseCreate.source,
          retryCount: awaitingResponseCreate.retryCount,
        });
        return;
      }

      awaitingResponseCreate.retryCount += 1;

      console.warn("[VOICE_REALTIME][RESPONSE_CREATE_RETRY_NO_RESPONSE_CREATED]", {
        callSid,
        source: awaitingResponseCreate.source,
        retryCount: awaitingResponseCreate.retryCount,
      });

      sendJson(params.openAiSocket, awaitingResponseCreate.event);
      scheduleAwaitingResponseCreateRetry();
    }, RESPONSE_CREATE_ACK_TIMEOUT_MS);
  }

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
      activeResponseSource,
      shouldInterruptActiveResponse,
    });

    const hasResponseInFlight = Boolean(activeResponseId || awaitingResponseSource);

    if (hasResponseInFlight) {
      pendingResponseCreate = event;
      pendingResponseSource = source;
      pendingResponseStartedAtUserTranscriptSeq = startedAtUserTranscriptSeq;

      console.warn("[VOICE_REALTIME][RESPONSE_CREATE_QUEUED]", {
        callSid,
        source,
        activeResponseId,
        activeResponseSource,
        awaitingResponseSource,
        shouldInterruptActiveResponse,
        shouldSupersede,
        startedAtUserTranscriptSeq,
      });

      if (
        activeResponseId &&
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
    awaitingResponseCreate = {
      event,
      source,
      startedAtUserTranscriptSeq,
      retryCount: 0,
    };

    console.warn("[VOICE_REALTIME][RESPONSE_CREATE_REQUESTED]", {
      callSid,
      source,
      startedAtUserTranscriptSeq,
      hasPendingResponseCreate: Boolean(pendingResponseCreate),
    });

    const sent = sendJson(params.openAiSocket, event);

    if (!sent) {
      console.warn("[VOICE_REALTIME][RESPONSE_CREATE_NOT_SENT_SOCKET_NOT_OPEN]", {
        callSid,
        source,
        socketReadyState: params.openAiSocket.readyState,
      });
      return;
    }

    scheduleAwaitingResponseCreateRetry();
  }

  function flushPendingRealtimeResponse(): boolean {
    if (!pendingResponseCreate) return false;
    if (activeResponseId) return false;
    if (awaitingResponseSource) return false;
    if (params.openAiSocket.readyState !== WebSocket.OPEN) return false;

    const callSid = params.getCallSid();

    const event = pendingResponseCreate;
    const source = clean(pendingResponseSource || "");
    const startedAtUserTranscriptSeq =
      pendingResponseStartedAtUserTranscriptSeq ?? activeResponseStartedAtUserTranscriptSeq;

    pendingResponseCreate = null;
    pendingResponseSource = null;
    pendingResponseStartedAtUserTranscriptSeq = null;

    activeResponseStartedAtUserTranscriptSeq = startedAtUserTranscriptSeq;

    awaitingResponseSource = source;
    awaitingResponseCreate = {
      event,
      source,
      startedAtUserTranscriptSeq,
      retryCount: 0,
    };

    console.warn("[VOICE_REALTIME][PENDING_RESPONSE_CREATE_FLUSHED]", {
      callSid,
      source,
      startedAtUserTranscriptSeq,
    });

    const sent = sendJson(params.openAiSocket, event);

    if (!sent) {
      console.warn("[VOICE_REALTIME][PENDING_RESPONSE_CREATE_NOT_SENT_SOCKET_NOT_OPEN]", {
        callSid,
        source,
        socketReadyState: params.openAiSocket.readyState,
      });
      return false;
    }

    scheduleAwaitingResponseCreateRetry();
    return true;
  }

  function markResponseCreated(paramsForResponse: {
    responseId: string | null;
    startedAtUserTranscriptSeq: number;
  }): ResponseControllerState {
    clearAwaitingResponseCreateRetryTimer();

    activeResponseId = paramsForResponse.responseId;
    activeResponseSource = awaitingResponseSource;
    activeResponseStartedAtUserTranscriptSeq =
      paramsForResponse.startedAtUserTranscriptSeq;

    awaitingResponseSource = null;
    awaitingResponseCreate = null;

    return getState();
  }

  function markResponseDone(paramsForResponse: {
    lastUserTranscriptSeq: number;
  }): ResponseControllerState {
    clearAwaitingResponseCreateRetryTimer();

    activeResponseId = null;
    activeResponseSource = null;
    activeResponseStartedAtUserTranscriptSeq =
      paramsForResponse.lastUserTranscriptSeq;

    awaitingResponseSource = null;
    awaitingResponseCreate = null;

    flushPendingRealtimeResponse();

    return getState();
  }

  function handleConversationAlreadyHasActiveResponseError(): void {
    const callSid = params.getCallSid();
    const streamSid = params.getStreamSid();

    console.warn("[VOICE_REALTIME][RESPONSE_ALREADY_ACTIVE_RETRY_QUEUED]", {
      callSid,
      activeResponseId,
      awaitingResponseSource,
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

    if (!awaitingResponseSource) {
      flushPendingRealtimeResponse();
    }
  }

  function handleResponseCancelNotActiveError(): void {
    const callSid = params.getCallSid();

    console.warn("[VOICE_REALTIME][RESPONSE_CANCEL_NOT_ACTIVE_IGNORED]", {
      callSid,
      activeResponseId,
      awaitingResponseSource,
      pendingResponseSource,
    });

    activeResponseId = null;
    activeResponseSource = null;

    if (!awaitingResponseSource) {
      flushPendingRealtimeResponse();
    }
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