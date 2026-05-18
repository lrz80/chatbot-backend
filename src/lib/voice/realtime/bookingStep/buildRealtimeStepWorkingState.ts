// src/lib/voice/realtime/bookingStep/buildRealtimeStepWorkingState.ts
import type { CallState } from "../../types";
import {
  buildAnswersBySlot,
  normalizeAnswersToCanonicalSlots,
  buildCanonicalCallState,
  type BookingFlowStepLike,
} from "../realtimeBookingFlowUtils";

export type RealtimeStepWorkingState = {
  rawAnswers: Record<string, string>;
  workingState: CallState;
};

export function buildRealtimeStepWorkingState(params: {
  args: Record<string, any>;
  callerPhone: string | null;
  state: CallState;
  steps: BookingFlowStepLike[];
  currentIndex: number;
}): RealtimeStepWorkingState {
  const { args, callerPhone, state, steps, currentIndex } = params;

  const rawAnswers = normalizeAnswersToCanonicalSlots({
    steps,
    answersBySlot: buildAnswersBySlot({
      args,
      callerPhone,
      state,
    }),
  });

  const workingState = buildCanonicalCallState({
    state,
    answersBySlot: rawAnswers,
    bookingStepIndex: currentIndex,
  });

  return {
    rawAnswers,
    workingState,
  };
}