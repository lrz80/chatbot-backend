//src/lib/voice/realtime/toolGuards/guardDirectCreateAppointment.ts
import WebSocket from "ws";
import type { CallState } from "../../types";
import type { RealtimeToolResult } from "../buildToolFollowupInstructions";
import { sendRealtimeJson } from "../socket/sendRealtimeJson";

type GuardDirectCreateAppointmentParams = {
  toolName: string;
  callId: string;
  callSid: string | null;
  openAiSocket: WebSocket;
  realtimeState: CallState;
  bookingFlowLoaded: boolean;
  callEnding: boolean;
  lastUserTranscript: string;
};

type GuardDirectCreateAppointmentResult =
  | {
      handled: false;
    }
  | {
      handled: true;
      result: RealtimeToolResult;
      realtimeState: CallState;
      bookingFlowLoaded: boolean;
      hangupRequestedByTool: false;
      callEnding: boolean;
      resetLastUserDigits: false;
    };

export function guardDirectCreateAppointment(
  params: GuardDirectCreateAppointmentParams
): GuardDirectCreateAppointmentResult {
  const {
    toolName,
    callId,
    callSid,
    openAiSocket,
    realtimeState,
    bookingFlowLoaded,
    callEnding,
    lastUserTranscript,
  } = params;

  if (toolName !== "create_appointment") {
    return { handled: false };
  }

  const blockedResult: RealtimeToolResult = {
    ok: false,
    error: "DIRECT_CREATE_APPOINTMENT_BLOCKED",
    message:
      "create_appointment is server-controlled and must only run from submit_booking_step action_required.",
  };

  console.warn("[VOICE_REALTIME][DIRECT_CREATE_APPOINTMENT_BLOCKED]", {
    callSid,
    callId,
    toolName,
    bookingTurnStatus: (realtimeState as any).bookingTurnStatus || "",
    pendingBookingStepKey: realtimeState.pendingBookingStepKey || "",
    lastUserTranscript,
    lastUserTranscriptSeq:
      typeof realtimeState.lastUserTranscriptSeq === "number"
        ? realtimeState.lastUserTranscriptSeq
        : null,
  });

  sendRealtimeJson(openAiSocket, {
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