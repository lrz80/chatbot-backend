// src/lib/voice/realtime/bookingStep/buildRealtimeStepWorkingState.ts
import type { CallState } from "../../types";
import {
  buildAnswersBySlot,
  normalizeAnswersToCanonicalSlots,
  buildCanonicalCallState,
  getStepSlot,
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

  const currentStep = steps[currentIndex] || null;
  const currentSlot = currentStep ? getStepSlot(currentStep) : "";
  const isServiceStep = currentSlot === "service";

  /**
   * Candidate answers include the currently submitted value.
   * These are passed to the step handler so it can validate/resolve the value.
   */
  const candidateAnswers = normalizeAnswersToCanonicalSlots({
    steps,
    answersBySlot: buildAnswersBySlot({
      args,
      callerPhone,
      state,
    }),
  });

  /**
   * Existing answers do NOT include the currently submitted value.
   * For service resolution, the submitted service must not enter workingState
   * until handleBookingServiceRealtimeStep confirms it resolved successfully.
   *
   * This prevents failed service attempts like "Folibogrowing" or
   * "I need to book an appointment" from marking the service step as completed.
   */
  const existingAnswers = normalizeAnswersToCanonicalSlots({
    steps,
    answersBySlot: buildAnswersBySlot({
      args: {},
      callerPhone,
      state,
    }),
  });

  const workingAnswers = isServiceStep ? existingAnswers : candidateAnswers;

  const workingState = buildCanonicalCallState({
    state,
    answersBySlot: workingAnswers,
    bookingStepIndex: currentIndex,
  });

  return {
    rawAnswers: candidateAnswers,
    workingState,
  };
}