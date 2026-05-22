// src/lib/voice/realtime/bookingStep/prepareRealtimeStepSubmission.ts
import type { CallState, VoiceLocale } from "../../types";
import {
  clean,
  getStepSlot,
  type BookingFlowStepLike,
  type BookingState,
} from "../realtimeBookingFlowUtils";
import { resolveExpectedRealtimeBookingStep } from "./resolveExpectedRealtimeBookingStep";
import { resolveRealtimeSubmittedStepValue } from "./resolveRealtimeSubmittedStepValue";

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

type PrepareRealtimeStepSubmissionParams = {
  callerPhone: string | null;
  args: Record<string, any>;
  bookingContext: {
    tenant: any;
    cfg: any;
    callSid: string;
    currentLocale: VoiceLocale;
    state: CallState;
    userInput: string;
  };
  steps: BookingFlowStepLike[];
  buildRealtimeBookingState: (params: {
    steps: BookingFlowStepLike[];
    state: CallState;
    explicitCurrentIndex?: number | null;
    finalConfirmationGranted?: boolean;
    readyToCreate?: boolean;
  }) => BookingState;
};

export type PreparedRealtimeStepSubmission =
  | {
      ok: true;
      stepKey: string;
      value: string;
      modelValue: string;
      rawTranscriptValue: string;
      currentIndex: number;
      currentStep: BookingFlowStepLike;
      targetSlot: string;
      resolvedInputValue: string;
      sanitizedArgs: Record<string, any>;
    }
  | {
      ok: false;
      result: any;
    };

export function prepareRealtimeStepSubmission(
  params: PrepareRealtimeStepSubmissionParams
): PreparedRealtimeStepSubmission {
  const {
    callerPhone,
    args,
    bookingContext,
    steps,
    buildRealtimeBookingState,
  } = params;

  const stepKey = clean(args.step_key);
  const value = clean(args.value);

  const originalModelValue = clean(args.model_value);
  const originalTranscriptValue = clean(
    args.raw_transcript_value ||
      args.transcript_value ||
      bookingContext.userInput
  );

  const candidateSource = clean(args.resolved_candidate_source);

  /**
   * Cuando handleRealtimeSubmitBookingStep está probando value_candidates,
   * cada candidato debe validarse por sí mismo contra el resolver oficial del step.
   *
   * prepareRealtimeStepSubmission no debe rechazar un candidato solo porque
   * el transcript crudo actual sea diferente. Esa comparación fue la causa de
   * INCOMPATIBLE_TEXT_VALUE en service.
   */
  const modelValue = candidateSource ? value : clean(args.model_value || args.value);
  const rawTranscriptValue = candidateSource ? value : originalTranscriptValue;

  if (!stepKey) {
    return {
      ok: false,
      result: {
        ok: false,
        error: "MISSING_STEP_KEY",
        message: "step_key is required.",
      },
    };
  }

  const expectedStepResolution = resolveExpectedRealtimeBookingStep({
    stepKey,
    steps,
    state: bookingContext.state,
    callerPhone,
    currentLocale: bookingContext.currentLocale,
    buildRealtimeBookingState,
  });

  if (!expectedStepResolution.ok) {
    return {
      ok: false,
      result: expectedStepResolution.result,
    };
  }

  const currentIndex = expectedStepResolution.currentIndex;
  const currentStep = expectedStepResolution.currentStep;
  const targetSlot = getStepSlot(currentStep);

  if (!targetSlot) {
    return {
      ok: false,
      result: {
        ok: false,
        error: "BOOKING_STEP_WITHOUT_SLOT",
        message: `Booking step ${stepKey} has no canonical slot.`,
      },
    };
  }

  const stepTimeZone =
    clean(
      bookingContext.cfg?.timezone ||
        bookingContext.cfg?.appointment_timezone ||
        bookingContext.tenant?.timezone
    ) || "America/New_York";

  const submittedStepValue = resolveRealtimeSubmittedStepValue({
    step: currentStep,
    value,
    rawTranscriptValue,
    modelValue,
    timeZone: stepTimeZone,
    callerPhone,
  });

  console.log("[VOICE_REALTIME][SUBMITTED_STEP_VALUE_RESOLVED]", {
    callSid: bookingContext.callSid,
    step_key: currentStep.step_key,
    expected_type: currentStep.expected_type,
    slot: targetSlot,
    raw_tool_value: value,
    model_value: modelValue,
    transcript_value: rawTranscriptValue,
    resolved_ok: submittedStepValue.ok,
    resolved_value: submittedStepValue.ok ? submittedStepValue.value : "",
    resolved_source: submittedStepValue.source,
    resolved_error: submittedStepValue.ok ? undefined : submittedStepValue.error,
  });

  if (!submittedStepValue.ok) {
    return {
      ok: false,
      result: {
        ok: false,
        error: submittedStepValue.error,
        currentStep,
        currentIndex,
        rawTranscriptValue,
        modelValue,
      },
    };
  }

  const resolvedInputValue = submittedStepValue.value;

  const sanitizedArgs = {
    ...args,
    value: resolvedInputValue,
    model_value: resolvedInputValue,
    resolved_value: resolvedInputValue,
    submitted_value: resolvedInputValue,
    raw_transcript_value: rawTranscriptValue,
    transcript_value: rawTranscriptValue,
    original_model_value: originalModelValue || modelValue,
    original_transcript_value: originalTranscriptValue,
    resolved_candidate_source: candidateSource || args.resolved_candidate_source || null,
  };

  return {
    ok: true,
    stepKey,
    value,
    modelValue,
    rawTranscriptValue,
    currentIndex,
    currentStep,
    targetSlot,
    resolvedInputValue,
    sanitizedArgs,
  };
}