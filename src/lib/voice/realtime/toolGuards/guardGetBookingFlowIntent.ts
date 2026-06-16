//src/lib/voice/realtime/toolGuards/guardGetBookingFlowIntent.ts
import WebSocket from "ws";
import type { CallState } from "../../types";
import type { RealtimeToolResult } from "../toolTypes";

type GuardGetBookingFlowIntentParams = {
  toolName: string;
  callId: string;
  callSid: string | null;
  openAiSocket: WebSocket;
  requestRealtimeResponse: (
    response?: Record<string, unknown>,
    source?: string
  ) => void;
  realtimeState: CallState;
  bookingFlowLoaded: boolean;
  callEnding: boolean;
  lastUserTranscript: string;
  lastUserDigits: string;
};

type GuardGetBookingFlowIntentResult =
  | {
      handled: true;
      result: RealtimeToolResult;
      realtimeState: CallState;
      bookingFlowLoaded: boolean;
      hangupRequestedByTool: false;
      callEnding: boolean;
      resetLastUserDigits: false;
    }
  | {
      handled: false;
    };

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

export function guardGetBookingFlowIntent(
  params: GuardGetBookingFlowIntentParams
): GuardGetBookingFlowIntentResult {
  const {
    toolName,
    callId,
    callSid,
    openAiSocket,
    requestRealtimeResponse,
    realtimeState,
    bookingFlowLoaded,
    callEnding,
    lastUserTranscript,
    lastUserDigits,
  } = params;

  if (toolName !== "get_booking_flow") {
    return { handled: false };
  }

  const acceptedTranscript = clean(lastUserTranscript);
  const acceptedDigits = clean(lastUserDigits);

  const hasAcceptedHumanInput =
    Boolean(acceptedTranscript) || Boolean(acceptedDigits);

  if (hasAcceptedHumanInput) {
    return { handled: false };
  }

  const blockedResult: RealtimeToolResult = {
    ok: false,
    error: "BOOKING_FLOW_REQUIRES_USER_INTENT",
    message:
      "Booking flow was not opened because there is no accepted human input yet.",
  };

  console.warn("[VOICE_REALTIME][GET_BOOKING_FLOW_BLOCKED_NO_USER_INTENT]", {
    callSid,
    toolName,
    lastUserTranscript: acceptedTranscript,
    lastUserDigits: acceptedDigits,
    lastUserTranscriptSeq:
      typeof realtimeState.lastUserTranscriptSeq === "number"
        ? realtimeState.lastUserTranscriptSeq
        : null,
    bookingTurnStatus: (realtimeState as any).bookingTurnStatus || "",
    pendingBookingStepKey: realtimeState.pendingBookingStepKey || "",
  });

  sendJson(openAiSocket, {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(blockedResult),
    },
  });

  return {
    handled: true,
    result: blockedResult,
    realtimeState,
    bookingFlowLoaded,
    hangupRequestedByTool: false,
    callEnding,
    resetLastUserDigits: false,
  };
}