//src/lib/voice/realtime/handlers/bookingStepToolResults.ts
import type { CallState, VoiceLocale } from "../../types";
import type {
  BookingFlowStepLike,
  BookingState,
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

type BuildInvalidExpectedTypeResultParams = {
  steps: BookingFlowStepLike[];
  workingState: CallState;
  currentIndex: number;
  currentLocale: VoiceLocale;
  buildRealtimeBookingState: (params: {
    steps: BookingFlowStepLike[];
    state: CallState;
    explicitCurrentIndex?: number | null;
    finalConfirmationGranted?: boolean;
    readyToCreate?: boolean;
  }) => BookingState;
  buildNextRequiredStep: (params: {
    steps: BookingFlowStepLike[];
    bookingState: BookingState;
    locale?: VoiceLocale;
    overridePrompt?: string;
  }) => RealtimeMappedStep | null;
  error: string;
  message?: string;
};

export function buildInvalidExpectedTypeResult(
  params: BuildInvalidExpectedTypeResultParams
) {
  const bookingState = params.buildRealtimeBookingState({
    steps: params.steps,
    state: params.workingState,
    explicitCurrentIndex: params.currentIndex,
  });

  const finalMessage = params.message || params.error;

  return {
    ok: false,
    error: params.error,
    message: finalMessage,
    assistant_prompt: finalMessage,
    booking_state: bookingState,
    next_required_step: params.buildNextRequiredStep({
      steps: params.steps,
      bookingState,
      locale: params.currentLocale,
    }),
  };
}