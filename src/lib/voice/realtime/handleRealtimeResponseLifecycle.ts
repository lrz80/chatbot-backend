// src/lib/voice/realtime/handleRealtimeResponseLifecycle.ts
import type { CallState } from "../types";
import {
  getBookingTurnStatus,
  markBookingWaitingForUserAnswer,
} from "./bookingTurnState";

type HandleRealtimeResponseDoneParams = {
  event: any;
  callSid: string | null;
  realtimeState: CallState;
  lastUserTranscript: string;
  lastUserTranscriptSeq: number;
  activeResponseId: string | null;
  completedResponseSource: string | null;
  pendingResponseCreate: Record<string, unknown> | null;
  hangupRequestedByTool: boolean;
  endCallGoodbyeRequested: boolean;
  endCallGoodbyeResponseId: string | null;
  callEnding: boolean;
  onEndCallGoodbyeCompleted: () => void;
};

type HandleRealtimeResponseDoneResult = {
  realtimeState: CallState;
  activeResponseId: string | null;
  handled: boolean;
  shouldFlushPendingResponse: boolean;
};

function isBookingQuestionResponseSource(source: string | null): boolean {
  const cleanSource = String(source ?? "").trim();

  return (
    cleanSource === "tool_followup:get_booking_flow" ||
    cleanSource.startsWith("tool_followup:submit_booking_step")
  );
}

export function handleRealtimeResponseDone(
  params: HandleRealtimeResponseDoneParams
): HandleRealtimeResponseDoneResult {
  const completedResponseId =
    params.event?.response?.id || params.activeResponseId;

  let nextRealtimeState = params.realtimeState;

  const completedEndCallGoodbye =
    params.hangupRequestedByTool &&
    params.endCallGoodbyeRequested &&
    params.endCallGoodbyeResponseId &&
    completedResponseId === params.endCallGoodbyeResponseId;

  /**
   * Open the booking turn before the bridge flushes queued responses.
   * This keeps the booking state correct before the next response.create.
   */
  if (
    !completedEndCallGoodbye &&
    !params.callEnding &&
    isBookingQuestionResponseSource(params.completedResponseSource) &&
    getBookingTurnStatus(nextRealtimeState) === "waiting_assistant_prompt"
  ) {
    nextRealtimeState = markBookingWaitingForUserAnswer({
      realtimeState: nextRealtimeState,
      lastUserTranscriptSeq: params.lastUserTranscriptSeq,
    });

    console.log("[VOICE_REALTIME][BOOKING_TURN_OPENED_FOR_USER_ANSWER]", {
      callSid: params.callSid,
      completedResponseSource: params.completedResponseSource,
      bookingTurnStatus: (nextRealtimeState as any).bookingTurnStatus || "",
      pendingBookingStepKey: nextRealtimeState.pendingBookingStepKey || "",
      pendingBookingStepPrompt: nextRealtimeState.pendingBookingStepPrompt || "",
      pendingBookingStepPromptAnchorSeq:
        typeof nextRealtimeState.pendingBookingStepPromptAnchorSeq === "number"
          ? nextRealtimeState.pendingBookingStepPromptAnchorSeq
          : null,
      lastUserTranscript: params.lastUserTranscript,
      lastUserTranscriptSeq: params.lastUserTranscriptSeq,
    });
  }

  if (completedEndCallGoodbye) {
    params.onEndCallGoodbyeCompleted();
  }

  return {
    realtimeState: nextRealtimeState,
    activeResponseId: null,
    handled: true,
    shouldFlushPendingResponse: Boolean(params.pendingResponseCreate),
  };
}