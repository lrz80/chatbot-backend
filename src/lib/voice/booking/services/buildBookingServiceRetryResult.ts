// src/lib/voice/booking/services/buildBookingServiceRetryResult.ts

import type { CallState, VoiceLocale } from "../../types";
import type {
  BookingFlowStepLike,
  BookingState,
} from "../../realtime/realtimeBookingFlowUtils";
import { buildRealtimeNextRequiredStep } from "../../realtime/bookingStep/buildRealtimeNextRequiredStep";

type BuildBookingServiceRetryResultParams = {
  error: string;
  prompt: string;
  currentStep: BookingFlowStepLike;
  currentIndex: number;
  currentLocale: VoiceLocale;
  workingState: CallState;
  steps: BookingFlowStepLike[];
  serviceOptions?: string[];
  buildRealtimeBookingState: (params: {
    steps: BookingFlowStepLike[];
    state: CallState;
    explicitCurrentIndex?: number | null;
    finalConfirmationGranted?: boolean;
    readyToCreate?: boolean;
  }) => BookingState;
};

export function buildBookingServiceRetryResult(
  params: BuildBookingServiceRetryResultParams
): {
  kind: "return";
  result: any;
} {
  const bookingState = params.buildRealtimeBookingState({
    steps: params.steps,
    state: params.workingState,
    explicitCurrentIndex: params.currentIndex,
  });

  const nextStepResult = buildRealtimeNextRequiredStep({
    steps: params.steps,
    bookingState,
    locale: params.currentLocale,
    overridePrompt: params.prompt,
  });

  if (!nextStepResult.ok) {
    return {
      kind: "return",
      result: {
        ok: false,
        error: nextStepResult.error,
        step_key: nextStepResult.step_key,
        slot: nextStepResult.slot,
        prompt_error: nextStepResult.prompt_error,
        retry_prompt_error: nextStepResult.retry_prompt_error,
        message: "BOOKING_FLOW_CONFIGURATION_INVALID",
        booking_state: bookingState,
        next_required_step: null,
      },
    };
  }

  return {
    kind: "return",
    result: {
      ok: false,
      error: params.error,
      message: params.prompt,
      assistant_prompt: params.prompt,
      booking_state: bookingState,
      next_required_step: nextStepResult.next_required_step,
      service_options: params.serviceOptions || [],
    },
  };
}