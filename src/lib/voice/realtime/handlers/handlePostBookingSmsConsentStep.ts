// src/lib/voice/realtime/handlers/handlePostBookingSmsConsentStep.ts
import type { CallState, VoiceLocale } from "../../types";
import { resolveVoiceMetaSignal } from "../../resolveVoiceMetaSignal";
import {
  clean,
  normalizeComparable,
  buildCanonicalCallState,
  type BookingFlowStepLike,
  type BookingState,
} from "../realtimeBookingFlowUtils";
import { resolveExpectedTypeStepValue } from "../bookingStepValueValidators";
import { buildRealtimeNextRequiredStep } from "../bookingStep/buildRealtimeNextRequiredStep";

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
  persistVoiceState: (params: {
    tenantId: string;
    callSid: string;
    state: CallState;
    locale: VoiceLocale;
  }) => Promise<void>;
};

type SmsConsentResolution =
  | {
      ok: true;
      canonicalValue: "yes" | "no";
      rawValue: string;
    }
  | {
      ok: false;
    };

async function resolveSmsConsent(params: {
  currentStep: BookingFlowStepLike;
  value: string;
  modelValue: string;
  locale: VoiceLocale;
}): Promise<SmsConsentResolution> {
  const { currentStep, value, modelValue, locale } = params;

  const expectedTypeResult = resolveExpectedTypeStepValue({
    step: currentStep,
    value,
    modelValue,
  });

  if (expectedTypeResult.ok) {
    const resolvedValue = clean(expectedTypeResult.value);
    const comparableValue = normalizeComparable(resolvedValue);

    if (comparableValue === "yes") {
      return {
        ok: true,
        canonicalValue: "yes",
        rawValue: resolvedValue,
      };
    }

    if (comparableValue === "no") {
      return {
        ok: true,
        canonicalValue: "no",
        rawValue: resolvedValue,
      };
    }
  }

  const semanticValue = clean(value || modelValue);

  if (!semanticValue) {
    return { ok: false };
  }

  const semantic = await resolveVoiceMetaSignal({
    utterance: semanticValue,
    locale,
  });

  if (semantic.intent === "affirm") {
    return {
      ok: true,
      canonicalValue: "yes",
      rawValue: semanticValue,
    };
  }

  if (semantic.intent === "reject") {
    return {
      ok: true,
      canonicalValue: "no",
      rawValue: semanticValue,
    };
  }

  return { ok: false };
}

async function returnSmsConsentRetry(params: {
  tenantId: string;
  currentStep: BookingFlowStepLike;
  currentIndex: number;
  workingState: CallState;
  bookingContext: RealtimeBookingContextLike;
  steps: BookingFlowStepLike[];
  buildRealtimeBookingState: HandlePostBookingSmsConsentStepParams["buildRealtimeBookingState"];
  persistVoiceState: HandlePostBookingSmsConsentStepParams["persistVoiceState"];
}): Promise<any> {
  const {
    tenantId,
    currentStep,
    currentIndex,
    workingState,
    bookingContext,
    steps,
    buildRealtimeBookingState,
    persistVoiceState,
  } = params;

  const draftRetryState: CallState = {
    ...workingState,
    bookingStepIndex: currentIndex,
    pendingBookingStepKey: clean(currentStep.step_key),
    pendingBookingStepRequired: currentStep.required !== false,
  };

  const bookingState = buildRealtimeBookingState({
    steps,
    state: draftRetryState,
    explicitCurrentIndex: currentIndex,
  });

  const nextStepResult = buildRealtimeNextRequiredStep({
    steps,
    bookingState,
    locale: bookingContext.currentLocale,
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

  const baseNextStep = nextStepResult.next_required_step;
  const retryPrompt = clean(baseNextStep?.retry_prompt || baseNextStep?.prompt || "");

  const retryState: CallState = {
    ...draftRetryState,
    pendingBookingStepPrompt: retryPrompt,
  };

  Object.assign(bookingContext.state, retryState);

  await persistVoiceState({
    tenantId,
    callSid: bookingContext.callSid,
    state: retryState,
    locale: bookingContext.currentLocale,
  });

  const persistedBookingState = buildRealtimeBookingState({
    steps,
    state: retryState,
    explicitCurrentIndex: currentIndex,
  });

  const nextRequiredStep = baseNextStep
    ? {
        ...baseNextStep,
        prompt: retryPrompt,
        retry_prompt: retryPrompt,
      }
    : null;

  return {
    ok: false,
    error: "UNRESOLVED_BOOKING_SMS_CONSENT",
    message: retryPrompt,
    assistant_prompt: retryPrompt,
    booking_state: persistedBookingState,
    next_required_step: nextRequiredStep,
  };
}

export async function handlePostBookingSmsConsentStep(
  params: HandlePostBookingSmsConsentStepParams
): Promise<any> {
  const {
    tenantId,
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
    persistVoiceState,
  } = params;

  const value = clean(args.value);
  const modelValue = clean(args.model_value || "");

  const consentResolution = await resolveSmsConsent({
    currentStep,
    value,
    modelValue,
    locale: bookingContext.currentLocale,
  });

  if (!consentResolution.ok) {
    return await returnSmsConsentRetry({
      tenantId,
      currentStep,
      currentIndex,
      workingState,
      bookingContext,
      steps,
      buildRealtimeBookingState,
      persistVoiceState,
    });
  }

  const storageSlot = targetSlot && targetSlot !== "none" ? targetSlot : stepKey;

  const nextAnswers = {
    ...rawAnswers,
    [storageSlot]: consentResolution.canonicalValue,
    [stepKey]: consentResolution.canonicalValue,
    booking_sms_consent: consentResolution.canonicalValue,
  };

  const consentState = buildCanonicalCallState({
    state: workingState,
    answersBySlot: nextAnswers,
    bookingStepIndex: undefined,
  });

  const finalizedConsentState: CallState = {
    ...consentState,
    bookingStepIndex: undefined,
    pendingBookingStepKey: undefined,
    pendingBookingStepRequired: undefined,
    pendingBookingStepPrompt: undefined,
    pendingBookingStepPromptAnchorTranscript: undefined,
    pendingActionGranted: consentResolution.canonicalValue === "yes",
    pendingActionAnswered: true,
    pendingActionToolName: "send_booking_sms",
  };

  Object.assign(bookingContext.state, finalizedConsentState);

  await persistVoiceState({
    tenantId,
    callSid: bookingContext.callSid,
    state: finalizedConsentState,
    locale: bookingContext.currentLocale,
  });

  const bookingState = buildRealtimeBookingState({
    steps,
    state: finalizedConsentState,
    explicitCurrentIndex: null,
  });

  const smsConsentGranted = consentResolution.canonicalValue === "yes";

  return {
    ok: true,
    booking_state: bookingState,
    next_required_step: null,
    booking_sms_consent: consentResolution.canonicalValue,
    action_required: smsConsentGranted ? "send_booking_sms" : "skip_booking_sms",
    message: smsConsentGranted
      ? "BOOKING_SMS_CONSENT_GRANTED"
      : "BOOKING_SMS_CONSENT_REJECTED",
    assistant_prompt: "",
  };
}