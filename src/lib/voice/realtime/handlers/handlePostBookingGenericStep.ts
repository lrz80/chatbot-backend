//src/lib/voice/realtime/handlers/handlePostBookingGenericStep.ts
import type { CallState } from "../../types";
import {
  canonicalizeGenericStepValue,
  buildCanonicalCallState,
  type BookingFlowStepLike,
} from "../realtimeBookingFlowUtils";

type HandlePostBookingGenericStepParams = {
  stepKey: string;
  targetSlot: string;
  currentStep: BookingFlowStepLike;
  currentIndex: number;
  rawAnswers: Record<string, string>;
  workingState: CallState;
  value: string;
};

export function handlePostBookingGenericStep(
  params: HandlePostBookingGenericStepParams
): CallState {
  const {
    stepKey,
    targetSlot,
    currentStep,
    currentIndex,
    rawAnswers,
    workingState,
    value,
  } = params;

  const normalizedStepValue = canonicalizeGenericStepValue(currentStep, value);

  const storageSlot = targetSlot && targetSlot !== "none" ? targetSlot : stepKey;

  const nextAnswers = {
    ...rawAnswers,
    [storageSlot]: normalizedStepValue,
    [stepKey]: normalizedStepValue,
  };

  return buildCanonicalCallState({
    state: workingState,
    answersBySlot: nextAnswers,
    bookingStepIndex: currentIndex,
  });
}