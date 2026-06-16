// src/lib/voice/realtime/toolErrors/handleRealtimeToolError.ts
import type WebSocket from "ws";
import type { CallState } from "../../types";

type RealtimeToolResult = {
  ok: false;
  error: string;
  message?: string;
  response_message?: string;
  instructions?: string;
};

function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function resolveToolErrorFollowupInstructions(
  toolErrorResult: RealtimeToolResult
): string {
  return (
    clean(toolErrorResult.response_message) ||
    clean(toolErrorResult.message) ||
    clean(toolErrorResult.instructions)
  );
}

export function handleRealtimeToolError(params: {
  error: unknown;
  callSid: string | null;
  toolName: string;
  callId: string;
  openAiSocket: WebSocket;
  requestRealtimeResponse: (
    response?: Record<string, unknown>,
    source?: string
  ) => void;
  realtimeState: CallState;
  bookingFlowLoaded: boolean;
  callEnding: boolean;
}): {
  consumed: true;
  realtimeState: CallState;
  bookingFlowLoaded: boolean;
  hangupRequestedByTool: false;
  callEnding: boolean;
  resetLastUserDigits: false;
} {
  const {
    error,
    callSid,
    toolName,
    callId,
    openAiSocket,
    requestRealtimeResponse,
    realtimeState,
    bookingFlowLoaded,
    callEnding,
  } = params;

  console.error("[VOICE_REALTIME][TOOL_ERROR]", {
    callSid,
    toolName,
    error: error instanceof Error ? error.message : String(error),
  });

  const toolErrorResult: RealtimeToolResult = {
    ok: false,
    error: error instanceof Error ? error.message : "TOOL_ERROR",
  };

  sendJson(openAiSocket, {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(toolErrorResult),
    },
  });

  const followupInstructions =
    resolveToolErrorFollowupInstructions(toolErrorResult);

  if (followupInstructions) {
    requestRealtimeResponse(
      {
        instructions: followupInstructions,
      },
      `tool_error:${toolName}`
    );
  }

  return {
    consumed: true,
    realtimeState,
    bookingFlowLoaded,
    hangupRequestedByTool: false,
    callEnding,
    resetLastUserDigits: false,
  };
}