// src/lib/voice/realtime/bookingStep/buildRealtimeStepRetryResult.ts
import type { VoiceLocale } from "../../types";
import {
  clean,
  type BookingFlowStepLike,
  type BookingState,
} from "../realtimeBookingFlowUtils";
import {
  buildRealtimeNextRequiredStep,
  type RealtimeMappedStep,
} from "./buildRealtimeNextRequiredStep";

type BuildRealtimeStepRetryResultParams = {
  error: string;
  currentStep: BookingFlowStepLike;
  currentIndex: number;
  currentLocale: VoiceLocale;
  steps: BookingFlowStepLike[];
  bookingState: BookingState;
};

export type BuildRealtimeStepRetryResult =
  | {
      ok: false;
      error: string;
      message: string;
      assistant_prompt: string;
      booking_state: BookingState;
      next_required_step: RealtimeMappedStep | null;
    }
  | {
      ok: false;
      error: "BOOKING_STEP_TEMPLATE_INVALID";
      message: "BOOKING_FLOW_CONFIGURATION_INVALID";
      assistant_prompt: "";
      booking_state: BookingState;
      next_required_step: null;
      step_key: string;
      slot: string;
      prompt_error: string;
      retry_prompt_error: string;
    };

export function buildRealtimeStepRetryResult(
  params: BuildRealtimeStepRetryResultParams
): BuildRealtimeStepRetryResult {
  const { error, currentLocale, steps, bookingState } = params;

  const nextStepResult = buildRealtimeNextRequiredStep({
    steps,
    bookingState,
    locale: currentLocale,
  });

  if (!nextStepResult.ok) {
    return {
      ok: false,
      error: nextStepResult.error,
      message: "BOOKING_FLOW_CONFIGURATION_INVALID",
      assistant_prompt: "",
      booking_state: bookingState,
      next_required_step: null,
      step_key: nextStepResult.step_key,
      slot: nextStepResult.slot,
      prompt_error: String(nextStepResult.prompt_error),
      retry_prompt_error: String(nextStepResult.retry_prompt_error),
    };
  }

  const nextRequiredStep = nextStepResult.next_required_step;

  const retryPrompt = clean(
    nextRequiredStep?.retry_prompt || nextRequiredStep?.prompt || ""
  );

  const retryStep = nextRequiredStep
    ? {
        ...nextRequiredStep,
        prompt: retryPrompt,
        retry_prompt: retryPrompt,
      }
    : null;

  return {
    ok: false,
    error,
    message: retryPrompt,
    assistant_prompt: retryPrompt,
    booking_state: bookingState,
    next_required_step: retryStep,
  };
}