//src/lib/voice/realtime/toolGuards/guardDirectCreateAppointment.ts
import WebSocket from "ws";
import type { CallState } from "../../types";
import type { RealtimeToolResult } from "../toolTypes";
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

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function isIdlePostBookingConversation(state: CallState): boolean {
  const bookingTurnStatus = clean((state as any).bookingTurnStatus);
  const pendingBookingStepKey = clean((state as any).pendingBookingStepKey);
  const awaitingPostBookingClosure =
    (state as any).awaitingPostBookingClosure === true;

  return (
    awaitingPostBookingClosure &&
    !pendingBookingStepKey &&
    (!bookingTurnStatus || bookingTurnStatus === "idle")
  );
}

function requestPostBookingToolRecovery(params: {
  openAiSocket: WebSocket;
  callSid: string | null;
  callId: string;
  lastUserTranscript: string;
}): void {
  const { openAiSocket, callSid, callId, lastUserTranscript } = params;

  if (openAiSocket.readyState !== WebSocket.OPEN) {
    console.warn("[VOICE_REALTIME][DIRECT_CREATE_APPOINTMENT_RECOVERY_SKIPPED_SOCKET_CLOSED]", {
      callSid,
      callId,
    });
    return;
  }

  console.warn("[VOICE_REALTIME][DIRECT_CREATE_APPOINTMENT_RECOVERY_REQUESTED]", {
    callSid,
    callId,
    lastUserTranscript,
  });

  sendRealtimeJson(openAiSocket, {
    type: "response.create",
    response: {
      tool_choice: "auto",
      instructions: [
        "The previous tool call was invalid because the appointment flow has already completed.",
        "Do not call create_appointment.",
        "Do not call submit_booking_step unless the caller clearly asks to start a new booking.",

        "Continue the live phone conversation from the caller's latest message.",
        "Use the caller's active language.",

        "Use only configured tenant/business information that is already available in the active session or returned by an approved tool.",
        "Do not invent addresses, locations, hours, prices, services, policies, staff, availability, or contact details.",
        "If the caller asks for business information and the exact answer is not available, say that you do not have that detail available right now.",
        "If there is an approved business-info tool available for the requested information, use it instead of guessing.",

        "If the caller asks a question or requests information, answer the question first.",
        "After answering any post-booking question, ask whether they need anything else.",
        "Do not end the call immediately after answering a question unless the caller clearly says they are done.",

        "If the caller clearly indicates they are done, does not need anything else, thanks the business as a closing, says goodbye, or asks to end the call, call end_call.",

        `Caller latest message: ${JSON.stringify(lastUserTranscript)}`,
      ].join("\n"),
    },
  });
}

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

  const isPostBookingIdle = isIdlePostBookingConversation(realtimeState);

  const blockedResult: RealtimeToolResult = {
    ok: false,
    error: "DIRECT_CREATE_APPOINTMENT_BLOCKED",
    message: isPostBookingIdle
      ? "create_appointment was blocked because the appointment flow is already completed. Continue the post-booking conversation instead."
      : "create_appointment is server-controlled and must only run from submit_booking_step action_required.",
  };

  console.warn("[VOICE_REALTIME][DIRECT_CREATE_APPOINTMENT_BLOCKED]", {
    callSid,
    callId,
    toolName,
    bookingTurnStatus: clean((realtimeState as any).bookingTurnStatus),
    pendingBookingStepKey: clean((realtimeState as any).pendingBookingStepKey),
    awaitingPostBookingClosure:
      (realtimeState as any).awaitingPostBookingClosure === true,
    isPostBookingIdle,
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

  if (isPostBookingIdle && !callEnding) {
    requestPostBookingToolRecovery({
      openAiSocket,
      callSid,
      callId,
      lastUserTranscript,
    });
  }

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