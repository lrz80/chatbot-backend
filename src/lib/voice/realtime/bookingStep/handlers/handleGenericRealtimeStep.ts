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
import { buildRealtimeNextRequiredStep } from "../buildRealtimeNextRequiredStep";

export type HandleGenericRealtimeStepResult =
  | {
      kind: "return";
      result: any;
    }
  | {
      kind: "continue";
      workingState: CallState;
    };

function buildGenericStepRetryResult(params: {
  error: string;
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
  overridePrompt?: string;
}) {
  const {
    error,
    steps,
    workingState,
    currentIndex,
    currentLocale,
    buildRealtimeBookingState,
    overridePrompt,
  } = params;

  const bookingState = buildRealtimeBookingState({
    steps,
    state: workingState,
    explicitCurrentIndex: currentIndex,
  });

  const nextStepResult = buildRealtimeNextRequiredStep({
    steps,
    bookingState,
    locale: currentLocale,
    overridePrompt: clean(overridePrompt),
  });

  if (!nextStepResult.ok) {
    return {
      ok: false,
      error: nextStepResult.error,
      step_key: nextStepResult.step_key,
      slot: nextStepResult.slot,
      prompt_error: nextStepResult.prompt_error,
      retry_prompt_error: nextStepResult.retry_prompt_error,
      message: "BOOKING_FLOW_CONFIGURATION_INVALID",
      booking_state: bookingState,
      next_required_step: null,
    };
  }

  const nextRequiredStep = nextStepResult.next_required_step;
  const prompt = clean(
    nextRequiredStep?.prompt ||
      nextRequiredStep?.retry_prompt ||
      overridePrompt ||
      ""
  );

  return {
    ok: false,
    error,
    message: prompt,
    assistant_prompt: prompt,
    booking_state: bookingState,
    next_required_step: nextRequiredStep,
  };
}

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
}): HandleGenericRealtimeStepResult {
  const {
    currentStep,
    currentIndex,
    currentLocale,
    targetSlot,
    stepKey,
    resolvedInputValue,
    modelValue,
    rawAnswers,
    workingState,
    steps,
    buildRealtimeBookingState,
  } = params;

  const expectedTypeResult = resolveExpectedTypeStepValue({
    step: currentStep,
    value: resolvedInputValue,
    modelValue,
  });

  if (!expectedTypeResult.ok) {
    return {
      kind: "return",
      result: buildGenericStepRetryResult({
        error: expectedTypeResult.error,
        steps,
        workingState,
        currentIndex,
        currentLocale,
        buildRealtimeBookingState,
        overridePrompt: clean(currentStep.retry_prompt || currentStep.prompt),
      }),
    };
  }

  const resolvedStepValue = expectedTypeResult.value;

  const optionCandidates = extractStepOptionCandidates(currentStep);
  const hasConfiguredOptions = optionCandidates.length > 0;

  if (hasConfiguredOptions) {
    const resolvedToConfiguredOption = optionCandidates.some(
      (option) =>
        normalizeComparable(option.canonical) ===
        normalizeComparable(resolvedStepValue)
    );

    if (!resolvedToConfiguredOption) {
      return {
        kind: "return",
        result: buildGenericStepRetryResult({
          error: "UNRESOLVED_STEP_OPTION",
          steps,
          workingState,
          currentIndex,
          currentLocale,
          buildRealtimeBookingState,
          overridePrompt: clean(currentStep.retry_prompt || currentStep.prompt),
        }),
      };
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