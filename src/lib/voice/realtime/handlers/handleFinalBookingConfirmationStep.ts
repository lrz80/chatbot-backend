//src/lib/voice/realtime/handlers/handleFinalBookingConfirmationStep.ts
import type { CallState, VoiceLocale } from "../../types";
import {
  clean,
  canonicalizeGenericStepValue,
  buildCanonicalCallState,
  type BookingFlowStepLike,
  type BookingState,
} from "../realtimeBookingFlowUtils";

type RealtimeMappedStep = {
  step_key: string;
  step_order: number;
  slot: string;
  prompt: string;
  expected_type: string;
  required: boolean;
  retry_prompt: string;
  validation_config: Record<string, unknown> | null;
  prompt_translations: Record<string, unknown> | null;
  retry_prompt_translations: Record<string, unknown> | null;
};

type RealtimeBookingContextLike = {
  callSid: string;
  currentLocale: VoiceLocale;
  state: CallState;
};

type HandleFinalBookingConfirmationStepParams = {
  tenantId: string;
  stepKey: string;
  targetSlot: string;
  currentStep: BookingFlowStepLike;
  currentIndex: number;
  rawAnswers: Record<string, string>;
  workingState: CallState;
  bookingContext: RealtimeBookingContextLike;
  steps: BookingFlowStepLike[];
  value: string;
  buildRealtimeBookingState: (params: {
    steps: BookingFlowStepLike[];
    state: CallState;
    explicitCurrentIndex?: number | null;
    finalConfirmationGranted?: boolean;
    readyToCreate?: boolean;
  }) => BookingState;
  persistVoiceState: (params: {
    tenantId: string;
    callSid: string;
    state: CallState;
    locale: VoiceLocale;
  }) => Promise<void>;
};

export async function handleFinalBookingConfirmationStep(
  params: HandleFinalBookingConfirmationStepParams
): Promise<any> {
  const {
    tenantId,
    stepKey,
    targetSlot,
    currentStep,
    currentIndex,
    rawAnswers,
    workingState,
    bookingContext,
    steps,
    value,
    buildRealtimeBookingState,
    persistVoiceState,
  } = params;

  const normalizedStepValue = canonicalizeGenericStepValue(currentStep, value);

  const storageSlot = targetSlot && targetSlot !== "none" ? targetSlot : stepKey;

  const nextAnswers = {
    ...rawAnswers,
    [storageSlot]: normalizedStepValue,
    [stepKey]: normalizedStepValue,
  };

  const confirmationState = buildCanonicalCallState({
    state: workingState,
    answersBySlot: nextAnswers,
    bookingStepIndex: currentIndex,
  });

  Object.assign(bookingContext.state, confirmationState);

  await persistVoiceState({
    tenantId,
    callSid: bookingContext.callSid,
    state: confirmationState,
    locale: bookingContext.currentLocale,
  });

  const bookingState = buildRealtimeBookingState({
    steps,
    state: confirmationState,
    explicitCurrentIndex: null,
    finalConfirmationGranted: true,
    readyToCreate: true,
  });

  return {
    ok: true,
    booking_state: bookingState,
    next_required_step: null,
    assistant_prompt: "",
    action_required: "create_appointment",
  };
}