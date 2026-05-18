// src/lib/voice/realtime/bookingStep/handlers/handleDatetimeRealtimeStep.ts
import { executeCanonicalBookingDatetimeStep } from "../../../booking/handleBookingDatetimeStep";
import type { CallState, VoiceLocale } from "../../../types";
import {
  clean,
  buildCanonicalCallState,
  parseJsonStringArray,
  type BookingFlowStepLike,
  type BookingState,
} from "../../realtimeBookingFlowUtils";

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

export type HandleDatetimeRealtimeStepResult =
  | {
      kind: "return";
      result: any;
    }
  | {
      kind: "continue";
      workingState: CallState;
    };

export async function handleDatetimeRealtimeStep(params: {
  tenantId: string;
  callSid: string;
  callerPhone: string | null;
  currentStep: BookingFlowStepLike;
  currentIndex: number;
  currentLocale: VoiceLocale;
  targetSlot: string;
  stepKey: string;
  rawAnswers: Record<string, string>;
  workingState: CallState;
  resolvedInputValue: string;
  modelValue: string;
  rawTranscriptValue: string;
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
}): Promise<HandleDatetimeRealtimeStepResult> {
  const {
    tenantId,
    callSid,
    callerPhone,
    currentStep,
    currentIndex,
    currentLocale,
    targetSlot,
    stepKey,
    rawAnswers,
    workingState,
    resolvedInputValue,
    modelValue,
    rawTranscriptValue,
    steps,
    buildRealtimeBookingState,
    buildNextRequiredStep,
  } = params;

  console.log("[VOICE_REALTIME][DATETIME_INPUT_SELECTED]", {
    callSid,
    modelValue,
    transcriptValue: rawTranscriptValue,
    selectedValue: resolvedInputValue,
  });

  const datetimeResult = await executeCanonicalBookingDatetimeStep({
    tenantId,
    callSid,
    currentStep: currentStep as any,
    currentIndex,
    currentLocale,
    callerE164: callerPhone,
    state: workingState,
    resolvedStepValue: resolvedInputValue,
  });

  if (datetimeResult.kind === "retry") {
    const retryState = datetimeResult.state;

    const suggestedStarts = parseJsonStringArray(
      retryState.bookingData?.__datetime_reference_suggested_starts
    );

    const bookingState = buildRealtimeBookingState({
      steps,
      state: retryState,
      explicitCurrentIndex: currentIndex,
    });

    const finalRetryPrompt = datetimeResult.prompt;

    const isAvailabilityWindow =
      datetimeResult.context === "availability_window";

    return {
      kind: "return",
      result: {
        ok: isAvailabilityWindow,
        error: isAvailabilityWindow
          ? undefined
          : datetimeResult.context === "slot_unavailable"
            ? "SLOT_UNAVAILABLE"
            : "INVALID_DATETIME_STEP",
        action_required: isAvailabilityWindow
          ? "choose_from_availability_window"
          : undefined,
        message: finalRetryPrompt,
        assistant_prompt: finalRetryPrompt,
        suggested_times: suggestedStarts,
        booking_state: bookingState,
        next_required_step: {
          ...buildNextRequiredStep({
            steps,
            bookingState,
            locale: currentLocale,
          }),
          prompt: finalRetryPrompt,
        },
      },
    };
  }

  const nextAnswers = {
    ...rawAnswers,
    [targetSlot]: datetimeResult.resolvedValue,
    [stepKey]: datetimeResult.resolvedValue,
    datetime: clean(
      datetimeResult.nextState.bookingData?.datetime ||
        datetimeResult.resolvedValue
    ),
    datetime_iso: clean(datetimeResult.nextState.bookingData?.datetime_iso || ""),
    datetime_display: clean(
      datetimeResult.nextState.bookingData?.datetime_display ||
        datetimeResult.resolvedValue
    ),
  };

  return {
    kind: "continue",
    workingState: buildCanonicalCallState({
      state: datetimeResult.nextState,
      answersBySlot: nextAnswers,
      bookingStepIndex: currentIndex,
    }),
  };
}