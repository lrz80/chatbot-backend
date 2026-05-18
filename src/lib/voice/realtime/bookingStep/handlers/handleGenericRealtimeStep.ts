// src/lib/voice/realtime/bookingStep/handlers/handleGenericRealtimeStep.ts
import type { CallState, VoiceLocale } from "../../../types";
import {
  clean,
  normalizeComparable,
  buildCanonicalCallState,
  extractStepOptionCandidates,
  type BookingFlowStepLike,
  type BookingState,
} from "../../realtimeBookingFlowUtils";
import { resolveExpectedTypeStepValue } from "../../bookingStepValueValidators";
import { buildInvalidExpectedTypeResult } from "../../handlers/bookingStepToolResults";

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

export type HandleGenericRealtimeStepResult =
  | {
      kind: "return";
      result: any;
    }
  | {
      kind: "continue";
      workingState: CallState;
    };

export function handleGenericRealtimeStep(params: {
  currentStep: BookingFlowStepLike;
  currentIndex: number;
  currentLocale: VoiceLocale;
  targetSlot: string;
  stepKey: string;
  resolvedInputValue: string;
  modelValue: string;
  callerPhone: string | null;
  rawAnswers: Record<string, string>;
  workingState: CallState;
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
}): HandleGenericRealtimeStepResult {
  const {
    currentStep,
    currentIndex,
    currentLocale,
    targetSlot,
    stepKey,
    resolvedInputValue,
    modelValue,
    callerPhone,
    rawAnswers,
    workingState,
    steps,
    buildRealtimeBookingState,
    buildNextRequiredStep,
  } = params;

  const expectedTypeResult = resolveExpectedTypeStepValue({
    step: currentStep,
    value: resolvedInputValue,
    modelValue,
  });

  if (!expectedTypeResult.ok) {
    return {
      kind: "return",
      result: buildInvalidExpectedTypeResult({
        steps,
        workingState,
        currentIndex,
        currentLocale,
        buildRealtimeBookingState,
        buildNextRequiredStep,
        error: expectedTypeResult.error,
        message: clean(currentStep.retry_prompt || currentStep.prompt),
      }),
    };
  }

  let resolvedStepValue = expectedTypeResult.value;

  const optionCandidates = extractStepOptionCandidates(currentStep);
  const hasConfiguredOptions = optionCandidates.length > 0;

  if (hasConfiguredOptions) {
    const resolvedToConfiguredOption = optionCandidates.some(
      (option) =>
        normalizeComparable(option.canonical) ===
        normalizeComparable(resolvedStepValue)
    );

    if (!resolvedToConfiguredOption) {
      const bookingState = buildRealtimeBookingState({
        steps,
        state: workingState,
        explicitCurrentIndex: currentIndex,
      });

      return {
        kind: "return",
        result: {
          ok: false,
          error: "UNRESOLVED_STEP_OPTION",
          message:
            "The requested value could not be resolved to a configured canonical option.",
          booking_state: bookingState,
          next_required_step: buildNextRequiredStep({
            steps,
            bookingState,
            locale: currentLocale,
          }),
        },
      };
    }
  }

  const validationMode = clean(currentStep.validation_config?.mode);
  const useInboundCaller =
    currentStep.validation_config?.use_inbound_caller === true;

  if (
    targetSlot === "customer_phone" &&
    validationMode === "confirm_or_replace" &&
    useInboundCaller
  ) {
    const existingPhone =
      clean(rawAnswers.customer_phone) || clean(callerPhone);

    const digitsOnly = clean(resolvedInputValue).replace(/\D+/g, "");

    if (digitsOnly.length >= 7) {
      resolvedStepValue = clean(resolvedInputValue);
    } else if (existingPhone) {
      resolvedStepValue = existingPhone;
    }
  }

  const nextAnswers = {
    ...rawAnswers,
    [targetSlot]: resolvedStepValue,
    [stepKey]: resolvedStepValue,
  };

  return {
    kind: "continue",
    workingState: buildCanonicalCallState({
      state: workingState,
      answersBySlot: nextAnswers,
      bookingStepIndex: currentIndex,
    }),
  };
}