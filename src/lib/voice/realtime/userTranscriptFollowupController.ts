//src/lib/voice/realtime/userTranscriptFollowupController.ts
import type { CallState } from "../types";

type RequestRealtimeResponse = (
  response?: Record<string, unknown>,
  source?: string
) => void;

type UserTranscriptFollowupControllerParams = {
  getCallSid: () => string | null;
  getRealtimeState: () => CallState;
  getLastUserTranscript: () => string;
  getLastUserTranscriptSeq: () => number;
  getBookingFlowLoaded: () => boolean;
  requestRealtimeResponse: RequestRealtimeResponse;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export function createUserTranscriptFollowupController(
  params: UserTranscriptFollowupControllerParams
) {
  let lastUserTranscriptFollowupSeq = 0;

  function reset(): void {
    lastUserTranscriptFollowupSeq = 0;
  }

  function requestFollowupAfterAcceptedUserTranscript(): void {
    const transcript = clean(params.getLastUserTranscript());

    if (!transcript) return;

    const lastUserTranscriptSeq = params.getLastUserTranscriptSeq();

    if (lastUserTranscriptFollowupSeq === lastUserTranscriptSeq) {
      return;
    }

    const realtimeState = params.getRealtimeState();

    const bookingTurnStatus = clean((realtimeState as any).bookingTurnStatus);
    const pendingBookingStepKey = clean(
      (realtimeState as any).pendingBookingStepKey
    );

    const isInsideBookingRuntime =
      Boolean(pendingBookingStepKey) ||
      bookingTurnStatus === "waiting_assistant_prompt" ||
      bookingTurnStatus === "waiting_user_answer";

    if (isInsideBookingRuntime) {
      return;
    }

    lastUserTranscriptFollowupSeq = lastUserTranscriptSeq;

    console.warn("[VOICE_REALTIME][USER_TRANSCRIPT_FOLLOWUP_REQUESTED]", {
      callSid: params.getCallSid(),
      transcript,
      lastUserTranscriptSeq,
      bookingFlowLoaded: params.getBookingFlowLoaded(),
      bookingTurnStatus,
      pendingBookingStepKey,
    });

    params.requestRealtimeResponse(
      {
        instructions: [
          "The caller just said this:",
          transcript,
          "Respond naturally using the current session instructions.",
          "If the caller is asking to book, schedule, reserve, or make an appointment, call get_booking_flow now.",
          "If the caller is asking a normal business question, answer normally.",
          "Do not invent booking details.",
          "Do not ignore the caller.",
        ].join(" "),
      },
      "bridge:user_transcript_followup"
    );
  }

  return {
    reset,
    requestFollowupAfterAcceptedUserTranscript,
  };
}