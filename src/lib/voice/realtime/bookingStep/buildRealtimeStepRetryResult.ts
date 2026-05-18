// src/lib/voice/realtime/bookingStep/buildRealtimeStepRetryResult.ts
import type { VoiceLocale } from "../../types";
import {
  clean,
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

type BuildRealtimeStepRetryResultParams = {
  error: string;
  currentStep: BookingFlowStepLike;
  currentIndex: number;
  currentLocale: VoiceLocale;
  steps: BookingFlowStepLike[];
  bookingState: BookingState;
  buildNextRequiredStep: (params: {
    steps: BookingFlowStepLike[];
    bookingState: BookingState;
    locale?: VoiceLocale;
    overridePrompt?: string;
  }) => RealtimeMappedStep | null;
};

export function buildRealtimeStepRetryResult(
  params: BuildRealtimeStepRetryResultParams
): {
  ok: false;
  error: string;
  message: string;
  assistant_prompt: string;
  booking_state: BookingState;
  next_required_step: RealtimeMappedStep | null;
} {
  const {
    error,
    currentStep,
    currentLocale,
    steps,
    bookingState,
    buildNextRequiredStep,
  } = params;

  const retryPrompt = clean(currentStep.retry_prompt || currentStep.prompt);

  return {
    ok: false,
    error,
    message: retryPrompt,
    assistant_prompt: retryPrompt,
    booking_state: bookingState,
    next_required_step: buildNextRequiredStep({
      steps,
      bookingState,
      locale: currentLocale,
      overridePrompt: retryPrompt,
    }),
  };
}