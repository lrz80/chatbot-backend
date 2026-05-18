// src/lib/voice/realtime/toolGuards/guardTenantReady.ts
import WebSocket from "ws";
import type { CallState } from "../../types";

type GuardTenantReadyResult =
  | {
      handled: false;
    }
  | {
      handled: true;
      realtimeState: CallState;
      bookingFlowLoaded: boolean;
      hangupRequestedByTool: false;
      callEnding: boolean;
      resetLastUserDigits: false;
    };

function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

export function guardTenantReady(params: {
  tenantId: string | null;
  callId: string;
  openAiSocket: WebSocket;
  requestRealtimeResponse: (
    response?: Record<string, unknown>,
    source?: string
  ) => void;
  realtimeState: CallState;
  bookingFlowLoaded: boolean;
  callEnding: boolean;
}): GuardTenantReadyResult {
  const {
    tenantId,
    callId,
    openAiSocket,
    requestRealtimeResponse,
    realtimeState,
    bookingFlowLoaded,
    callEnding,
  } = params;

  if (tenantId) {
    return {
      handled: false,
    };
  }

  sendJson(openAiSocket, {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify({
        ok: false,
        error: "TENANT_NOT_READY",
      }),
    },
  });

  requestRealtimeResponse(
    {
      instructions:
        "Tell the caller briefly that the system is not ready to complete that action yet.",
    },
    "tool_guard:tenant_not_ready"
  );

  return {
    handled: true,
    realtimeState,
    bookingFlowLoaded,
    hangupRequestedByTool: false,
    callEnding,
    resetLastUserDigits: false,
  };
}