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

export function handleRealtimeResponseDone(
  params: HandleRealtimeResponseDoneParams
): HandleRealtimeResponseDoneResult {
  const completedResponseId = params.event?.response?.id || params.activeResponseId;

  let nextRealtimeState = params.realtimeState;

  const hadPendingResponse = Boolean(params.pendingResponseCreate);

  if (hadPendingResponse) {
    params.flushPendingRealtimeResponse();

    return {
      realtimeState: nextRealtimeState,
      activeResponseId: null,
      handled: true,
    };
  }

  const completedEndCallGoodbye =
    params.hangupRequestedByTool &&
    params.endCallGoodbyeRequested &&
    params.endCallGoodbyeResponseId &&
    completedResponseId === params.endCallGoodbyeResponseId;

  if (
    !completedEndCallGoodbye &&
    !params.callEnding &&
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
    });
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