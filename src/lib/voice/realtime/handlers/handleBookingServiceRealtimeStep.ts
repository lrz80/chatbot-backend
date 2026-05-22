// src/lib/voice/realtime/handlers/handleBookingServiceRealtimeStep.ts
import type { CallState, VoiceLocale } from "../../types";
import { executeCanonicalBookingServiceStep } from "../../booking/handleBookingServiceStep";
import {
  buildCanonicalCallState,
  type BookingFlowStepLike,
  type BookingState,
} from "../realtimeBookingFlowUtils";
import { buildRealtimeNextRequiredStep } from "../bookingStep/buildRealtimeNextRequiredStep";

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

    const nextStepResult = buildRealtimeNextRequiredStep({
      steps,
      bookingState,
      locale: currentLocale,
      overridePrompt: serviceResult.prompt,
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
        error:
          serviceResult.kind === "ambiguous"
            ? "AMBIGUOUS_BOOKING_SERVICE"
            : "UNRESOLVED_BOOKING_SERVICE",
        message: serviceResult.prompt,
        assistant_prompt: serviceResult.prompt,
        booking_state: bookingState,
        next_required_step: nextStepResult.next_required_step,
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