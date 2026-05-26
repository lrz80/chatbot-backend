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
  flushPendingRealtimeResponse: () => void;
  onEndCallGoodbyeCompleted: () => void;
};

type HandleRealtimeResponseDoneResult = {
  realtimeState: CallState;
  activeResponseId: string | null;
  handled: boolean;
};

function isBookingQuestionResponseSource(source: string | null): boolean {
  return (
    source === "tool_followup:get_booking_flow" ||
    source === "tool_followup:submit_booking_step"
  );
}

export function handleRealtimeResponseDone(
  params: HandleRealtimeResponseDoneParams
): HandleRealtimeResponseDoneResult {
  const completedResponseId = params.event?.response?.id || params.activeResponseId;

  let nextRealtimeState = params.realtimeState;

  const completedEndCallGoodbye =
    params.hangupRequestedByTool &&
    params.endCallGoodbyeRequested &&
    params.endCallGoodbyeResponseId &&
    completedResponseId === params.endCallGoodbyeResponseId;

  /**
   * Important:
   * Open the booking turn BEFORE flushing any queued response.
   * Otherwise the state can stay stuck in waiting_assistant_prompt forever.
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
      bookingTurnStatus: (nextRealtimeState as any).bookingTurnStatus || "",
      pendingBookingStepKey: nextRealtimeState.pendingBookingStepKey || "",
      pendingBookingStepPrompt: nextRealtimeState.pendingBookingStepPrompt || "",
      pendingBookingStepPromptAnchorSeq:
        typeof nextRealtimeState.pendingBookingStepPromptAnchorSeq === "number"
          ? nextRealtimeState.pendingBookingStepPromptAnchorSeq
          : null,
      lastUserTranscript: params.lastUserTranscript,
      lastUserTranscriptSeq: params.lastUserTranscriptSeq,
      completedResponseSource: params.completedResponseSource,
    });
  }

  const hadPendingResponse = Boolean(params.pendingResponseCreate);

  if (hadPendingResponse) {
    params.flushPendingRealtimeResponse();

    return {
      realtimeState: nextRealtimeState,
      activeResponseId: null,
      handled: true,
    };
  }

  if (completedEndCallGoodbye) {
    params.onEndCallGoodbyeCompleted();
  }

  return {
    realtimeState: nextRealtimeState,
    activeResponseId: null,
    handled: true,
  };
}