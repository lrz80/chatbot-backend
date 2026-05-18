//src/lib/voice/realtime/handlers/handleBookingServiceRealtimeStep.ts
import type { CallState, VoiceLocale } from "../../types";
import { executeCanonicalBookingServiceStep } from "../../booking/handleBookingServiceStep";
import {
  clean,
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

type HandleBookingServiceRealtimeStepParams = {
  callerPhone: string | null;
  currentStep: BookingFlowStepLike;
  currentIndex: number;
  currentLocale: VoiceLocale;
  value: string;
  targetSlot: string;
  stepKey: string;
  rawAnswers: Record<string, string>;
  workingState: CallState;
  rawConfig: string;
  steps: BookingFlowStepLike[];
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
};

type HandleBookingServiceRealtimeStepResult =
  | {
      kind: "return";
      result: any;
    }
  | {
      kind: "continue";
      workingState: CallState;
    };

export async function handleBookingServiceRealtimeStep(
  params: HandleBookingServiceRealtimeStepParams
): Promise<HandleBookingServiceRealtimeStepResult> {
  const {
    callerPhone,
    currentStep,
    currentIndex,
    currentLocale,
    value,
    targetSlot,
    stepKey,
    rawAnswers,
    workingState,
    rawConfig,
    steps,
    buildRealtimeBookingState,
    buildNextRequiredStep,
  } = params;

  const serviceResult = await executeCanonicalBookingServiceStep({
    currentStep: currentStep as any,
    currentLocale,
    callerE164: callerPhone,
    effectiveUserInput: value,
    state: workingState,
    rawConfig,
  });

  if (serviceResult.kind === "retry" || serviceResult.kind === "ambiguous") {
    const bookingState = buildRealtimeBookingState({
      steps,
      state: workingState,
      explicitCurrentIndex: currentIndex,
    });

    return {
      kind: "return",
      result: {
        ok: false,
        error:
          serviceResult.kind === "ambiguous"
            ? "AMBIGUOUS_BOOKING_SERVICE"
            : "UNRESOLVED_BOOKING_SERVICE",
        message: serviceResult.prompt,
        assistant_prompt: serviceResult.prompt,
        booking_state: bookingState,
        next_required_step: buildNextRequiredStep({
          steps,
          bookingState,
          locale: currentLocale,
          overridePrompt: serviceResult.prompt,
        }),
        service_options:
          serviceResult.kind === "ambiguous" ? serviceResult.options : [],
      },
    };
  }

  const nextAnswers = {
    ...rawAnswers,
    [targetSlot]: serviceResult.resolvedValue,
    [stepKey]: serviceResult.resolvedValue,
  };

  return {
    kind: "continue",
    workingState: buildCanonicalCallState({
      state: serviceResult.state,
      answersBySlot: nextAnswers,
      bookingStepIndex: currentIndex,
    }),
  };
}