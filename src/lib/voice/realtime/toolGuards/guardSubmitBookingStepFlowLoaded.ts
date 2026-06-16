// src/lib/voice/realtime/toolGuards/guardSubmitBookingStepFlowLoaded.ts
import type WebSocket from "ws";
import type { CallState } from "../../types";
import type { RealtimeToolResult } from "../toolTypes";

export type GuardSubmitBookingStepFlowLoadedResult =
  | {
      handled: false;
    }
  | {
      handled: true;
      result: RealtimeToolResult;
      realtimeState: CallState;
      bookingFlowLoaded: boolean;
      hangupRequestedByTool: boolean;
      callEnding: boolean;
      resetLastUserDigits: boolean;
    };

function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

export function guardSubmitBookingStepFlowLoaded(params: {
  toolName: string;
  callId: string;
  openAiSocket: WebSocket;
  requestRealtimeResponse: (
    response?: Record<string, unknown>,
    source?: string
  ) => void;
  callSid: string | null;
  realtimeState: CallState;
  bookingFlowLoaded: boolean;
  callEnding: boolean;
}): GuardSubmitBookingStepFlowLoadedResult {
  const {
    toolName,
    callId,
    openAiSocket,
    requestRealtimeResponse,
    callSid,
    realtimeState,
    bookingFlowLoaded,
    callEnding,
  } = params;

  if (toolName !== "submit_booking_step" || bookingFlowLoaded) {
    return {
      handled: false,
    };
  }

  const blockedResult: RealtimeToolResult = {
    ok: false,
    error: "BOOKING_FLOW_NOT_LOADED",
  };

  console.log("[VOICE_REALTIME][TOOL_RESULT]", {
    callSid,
    toolName,
    ok: false,
    error: blockedResult.error,
  });

  sendJson(openAiSocket, {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(blockedResult),
    },
  });

  requestRealtimeResponse({
    instructions: [
      "Call get_booking_flow now.",
      "Do not ask for any booking data yet.",
      "Do not call submit_booking_step again until get_booking_flow returns.",
      "After get_booking_flow returns, ask the next required booking question.",
      "Do not invent the current booking step.",
    ].join(" "),
  });

  return {
    handled: true,
    result: blockedResult,
    realtimeState: {
      ...realtimeState,
      bookingStepIndex: undefined,
      pendingBookingStepKey: undefined,
    } as CallState,
    bookingFlowLoaded: false,
    hangupRequestedByTool: false,
    callEnding,
    resetLastUserDigits: true,
  };
}