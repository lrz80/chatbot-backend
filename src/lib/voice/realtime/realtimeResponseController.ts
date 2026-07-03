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
  sendToolOutputToOpenAi?: boolean;
};

type ResponseControllerState = {
  activeResponseId: string | null;
  activeResponseSource: string | null;
  activeResponseStartedAtUserTranscriptSeq: number;
  activeResponseSendToolOutputToOpenAi: boolean;
  pendingResponseCreate: Record<string, unknown> | null;
  pendingResponseSource: string | null;
  awaitingResponseSource: string | null;
};

type AwaitingResponseCreateState = {
  event: Record<string, unknown>;
  source: string;
  startedAtUserTranscriptSeq: number;
  sendToolOutputToOpenAi: boolean;
};

const RESPONSE_CREATE_ACK_TIMEOUT_MS = 5000;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
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
  let activeResponseSendToolOutputToOpenAi = true;

  let pendingResponseCreate: Record<string, unknown> | null = null;
  let pendingResponseSource: string | null = null;
  let pendingResponseStartedAtUserTranscriptSeq: number | null = null;
  let pendingResponseSendToolOutputToOpenAi = true;

  let awaitingResponseSource: string | null = null;
  let awaitingResponseCreate: AwaitingResponseCreateState | null = null;
  let awaitingResponseCreateWatchdogTimer: ReturnType<typeof setTimeout> | null =
    null;

  function clearAwaitingResponseCreateWatchdogTimer(): void {
    if (!awaitingResponseCreateWatchdogTimer) return;
    clearTimeout(awaitingResponseCreateWatchdogTimer);
    awaitingResponseCreateWatchdogTimer = null;
  }

  function scheduleAwaitingResponseCreateWatchdog(): void {
    clearAwaitingResponseCreateWatchdogTimer();

    if (!awaitingResponseCreate) return;

    awaitingResponseCreateWatchdogTimer = setTimeout(() => {
      const callSid = params.getCallSid();

      if (!awaitingResponseCreate) return;

      /**
       * Do not retry response.create here.
       *
       * response.create is not idempotent. Retrying it can create two assistant
       * responses for the same booking question when the first response.created
       * arrives late. That causes duplicated speech and can also lose the source
       * association for the late response.
       */
      console.warn("[VOICE_REALTIME][RESPONSE_CREATE_ACK_TIMEOUT_NO_RETRY]", {
        callSid,
        source: awaitingResponseCreate.source,
        startedAtUserTranscriptSeq:
          awaitingResponseCreate.startedAtUserTranscriptSeq,
        hasActiveResponse: Boolean(activeResponseId),
        hasPendingResponseCreate: Boolean(pendingResponseCreate),
        socketReadyState: params.openAiSocket.readyState,
      });
    }, RESPONSE_CREATE_ACK_TIMEOUT_MS);
  }

  function getState(): ResponseControllerState {
    return {
      activeResponseId,
      activeResponseSource,
      activeResponseStartedAtUserTranscriptSeq,
      activeResponseSendToolOutputToOpenAi,
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
    sendToolOutputToOpenAi = true,
  }: RequestRealtimeResponseParams): void {
    const callSid = params.getCallSid();
    const streamSid = params.getStreamSid();

    const cleanSource = clean(source);

    const shouldSupersede = shouldSupersedeActiveResponse({
      source: cleanSource,
      activeResponseSource,
      shouldInterruptActiveResponse,
    });

    const hasResponseInFlight = Boolean(
      activeResponseId || awaitingResponseSource
    );

    if (hasResponseInFlight) {
      pendingResponseCreate = event;
      pendingResponseSource = cleanSource;
      pendingResponseStartedAtUserTranscriptSeq = startedAtUserTranscriptSeq;
      pendingResponseSendToolOutputToOpenAi = sendToolOutputToOpenAi;

      console.warn("[VOICE_REALTIME][RESPONSE_CREATE_QUEUED]", {
        callSid,
        source: cleanSource,
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
          pendingResponseSource: cleanSource,
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
    awaitingResponseSource = cleanSource;
    awaitingResponseCreate = {
      event,
      source: cleanSource,
      startedAtUserTranscriptSeq,
      sendToolOutputToOpenAi,
    };

    const responsePayload = getObject(event.response);
    const responseInstructions = clean(responsePayload?.instructions || "");

    console.warn("[VOICE_REALTIME][RESPONSE_CREATE_REQUESTED]", {
      callSid,
      source: cleanSource,
      startedAtUserTranscriptSeq,
      hasPendingResponseCreate: Boolean(pendingResponseCreate),
      hasInstructions: Boolean(responseInstructions),
      instructionsLength: responseInstructions.length,
    });

    const sent = sendJson(params.openAiSocket, event);

    if (!sent) {
      console.warn("[VOICE_REALTIME][RESPONSE_CREATE_NOT_SENT_SOCKET_NOT_OPEN]", {
        callSid,
        source: cleanSource,
        socketReadyState: params.openAiSocket.readyState,
      });

      awaitingResponseSource = null;
      awaitingResponseCreate = null;
      return;
    }

    scheduleAwaitingResponseCreateWatchdog();
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
      pendingResponseStartedAtUserTranscriptSeq ??
      activeResponseStartedAtUserTranscriptSeq;
    const sendToolOutputToOpenAi = pendingResponseSendToolOutputToOpenAi;

    pendingResponseCreate = null;
    pendingResponseSource = null;
    pendingResponseStartedAtUserTranscriptSeq = null;
    pendingResponseSendToolOutputToOpenAi = true;

    activeResponseStartedAtUserTranscriptSeq = startedAtUserTranscriptSeq;

    awaitingResponseSource = source;
    awaitingResponseCreate = {
      event,
      source,
      startedAtUserTranscriptSeq,
      sendToolOutputToOpenAi,
    };

    const responsePayload = getObject(event.response);
    const responseInstructions = clean(responsePayload?.instructions || "");

    console.warn("[VOICE_REALTIME][PENDING_RESPONSE_CREATE_FLUSHED]", {
      callSid,
      source,
      startedAtUserTranscriptSeq,
      hasInstructions: Boolean(responseInstructions),
      instructionsLength: responseInstructions.length,
    });

    const sent = sendJson(params.openAiSocket, event);

    if (!sent) {
      console.warn("[VOICE_REALTIME][PENDING_RESPONSE_CREATE_NOT_SENT_SOCKET_NOT_OPEN]", {
        callSid,
        source,
        socketReadyState: params.openAiSocket.readyState,
      });

      awaitingResponseSource = null;
      awaitingResponseCreate = null;
      return false;
    }

    scheduleAwaitingResponseCreateWatchdog();
    return true;
  }

  function markResponseCreated(paramsForResponse: {
    responseId: string | null;
    startedAtUserTranscriptSeq: number;
  }): ResponseControllerState {
    const callSid = params.getCallSid();

    clearAwaitingResponseCreateWatchdogTimer();

    const responseId = clean(paramsForResponse.responseId || "");

    if (!awaitingResponseSource) {
      console.warn("[VOICE_REALTIME][RESPONSE_CREATED_WITHOUT_AWAITING_IGNORED]", {
        callSid,
        responseId: responseId || null,
        activeResponseId,
        activeResponseSource,
        pendingResponseSource,
      });

      return getState();
    }

    activeResponseId = responseId || null;
    activeResponseSource = awaitingResponseSource;
    activeResponseStartedAtUserTranscriptSeq =
      paramsForResponse.startedAtUserTranscriptSeq;
    activeResponseSendToolOutputToOpenAi =
      awaitingResponseCreate?.sendToolOutputToOpenAi !== false;

    awaitingResponseSource = null;
    awaitingResponseCreate = null;

    return getState();
  }

  function markResponseDone(paramsForResponse: {
    lastUserTranscriptSeq: number;
  }): ResponseControllerState {
    clearAwaitingResponseCreateWatchdogTimer();

    activeResponseId = null;
    activeResponseSource = null;
    activeResponseSendToolOutputToOpenAi = true;
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