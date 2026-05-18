//src/lib/voice/realtime/handlers/handlePostBookingSmsConsentStep.ts
import type { CallState, VoiceLocale } from "../../types";
import {
  clean,
  normalizeComparable,
  buildAnswersBySlot,
  normalizeAnswersToCanonicalSlots,
  buildCanonicalCallState,
  type BookingFlowStepLike,
  type BookingState,
} from "../realtimeBookingFlowUtils";
import { resolveExpectedTypeStepValue } from "../bookingStepValueValidators";

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

type RealtimeBookingContextLike = {
  callSid: string;
  currentLocale: VoiceLocale;
  state: CallState;
};

type HandlePostBookingSmsConsentStepParams = {
  tenantId: string;
  callerPhone: string | null;
  stepKey: string;
  targetSlot: string;
  currentStep: BookingFlowStepLike;
  currentIndex: number;
  rawAnswers: Record<string, string>;
  workingState: CallState;
  bookingContext: RealtimeBookingContextLike;
  steps: BookingFlowStepLike[];
  args: Record<string, any>;
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
  persistVoiceState: (params: {
    tenantId: string;
    callSid: string;
    state: CallState;
    locale: VoiceLocale;
  }) => Promise<void>;
};

export async function handlePostBookingSmsConsentStep(
  params: HandlePostBookingSmsConsentStepParams
): Promise<any> {
  const {
    tenantId,
    callerPhone,
    stepKey,
    targetSlot,
    currentStep,
    currentIndex,
    rawAnswers,
    workingState,
    bookingContext,
    steps,
    args,
    buildRealtimeBookingState,
    buildNextRequiredStep,
    persistVoiceState,
  } = params;

  const value = clean(args.value);
  const modelValue = clean(args.model_value || "");

  const expectedTypeResult = resolveExpectedTypeStepValue({
    step: currentStep,
    value,
    modelValue,
  });

  if (!expectedTypeResult.ok) {
    const bookingState = buildRealtimeBookingState({
      steps,
      state: workingState,
      explicitCurrentIndex: currentIndex,
    });

    return {
      ok: false,
      error: "UNRESOLVED_BOOKING_SMS_CONSENT",
      message:
        "The caller's SMS consent answer could not be resolved from the configured booking step.",
      assistant_prompt: clean(currentStep.retry_prompt || currentStep.prompt),
      booking_state: bookingState,
      next_required_step: buildNextRequiredStep({
        steps,
        bookingState,
        locale: bookingContext.currentLocale,
      }),
    };
  }

  const normalizedStepValue = clean(expectedTypeResult.value);
  const normalizedComparableValue = normalizeComparable(normalizedStepValue);

  const storageSlot = targetSlot && targetSlot !== "none" ? targetSlot : stepKey;

  const nextAnswers = {
    ...rawAnswers,
    [storageSlot]: normalizedStepValue,
    [stepKey]: normalizedStepValue,
    booking_sms_consent: normalizedStepValue,
  };

  const consentState = buildCanonicalCallState({
    state: workingState,
    answersBySlot: nextAnswers,
    bookingStepIndex: undefined,
  });

  Object.assign(bookingContext.state, consentState);

  await persistVoiceState({
    tenantId,
    callSid: bookingContext.callSid,
    state: consentState,
    locale: bookingContext.currentLocale,
  });

  const bookingState = buildRealtimeBookingState({
    steps,
    state: consentState,
    explicitCurrentIndex: null,
  });

  if (normalizedComparableValue !== "yes" && normalizedComparableValue !== "no") {
    return {
      ok: false,
      error: "UNRESOLVED_BOOKING_SMS_CONSENT",
      message:
        "The caller's SMS consent answer was resolved, but not to a canonical yes/no value.",
      assistant_prompt: clean(currentStep.retry_prompt || currentStep.prompt),
      booking_state: bookingState,
      next_required_step: buildNextRequiredStep({
        steps,
        bookingState,
        locale: bookingContext.currentLocale,
      }),
    };
  }

  const smsConsentGranted = normalizedComparableValue === "yes";

  return {
    ok: true,
    booking_state: bookingState,
    next_required_step: null,
    booking_sms_consent: normalizedStepValue,
    action_required: smsConsentGranted ? "send_booking_sms" : "skip_booking_sms",
    message: smsConsentGranted
      ? "El cliente aceptó recibir los detalles por SMS."
      : "El cliente no quiere recibir los detalles por SMS.",
    assistant_prompt: smsConsentGranted
      ? ""
      : "Perfecto, no envío el SMS. ¿Puedo ayudarte con algo más?",
  };
}