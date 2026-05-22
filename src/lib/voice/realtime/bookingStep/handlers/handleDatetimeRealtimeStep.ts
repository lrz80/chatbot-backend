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
import { buildRealtimeNextRequiredStep } from "../buildRealtimeNextRequiredStep";

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

    const finalRetryPrompt = clean(datetimeResult.prompt);

    const nextStepResult = buildRealtimeNextRequiredStep({
      steps,
      bookingState,
      locale: currentLocale,
      overridePrompt: finalRetryPrompt,
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

    const nextRequiredStep = nextStepResult.next_required_step
      ? {
          ...nextStepResult.next_required_step,
          prompt: finalRetryPrompt,
          retry_prompt: finalRetryPrompt,
        }
      : null;

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
        next_required_step: nextRequiredStep,
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