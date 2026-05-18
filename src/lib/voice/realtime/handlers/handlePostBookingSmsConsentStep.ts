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

type SmsConsentResolution =
  | {
      ok: true;
      canonicalValue: "yes" | "no";
      rawValue: string;
    }
  | {
      ok: false;
    };

function getRecordText(
  record: Record<string, unknown> | null | undefined,
  key: string
): string {
  const value = record?.[key];
  return typeof value === "string" ? clean(value) : "";
}

function getStepRecord(
  value: unknown
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function resolveLocalizedStepText(params: {
  baseText: string;
  translations: Record<string, unknown> | null;
  locale: VoiceLocale;
}): string {
  const { baseText, translations, locale } = params;

  const translated =
    getRecordText(translations, locale) ||
    getRecordText(translations, locale.split("-")[0]);

  return translated || clean(baseText);
}

function buildCurrentStepRetryPrompt(params: {
  currentStep: BookingFlowStepLike;
  locale: VoiceLocale;
}): string {
  const { currentStep, locale } = params;

  return resolveLocalizedStepText({
    baseText: clean(currentStep.retry_prompt || currentStep.prompt),
    translations: getStepRecord(currentStep.retry_prompt_translations),
    locale,
  });
}

function mapCurrentStepAsNextRequiredStep(params: {
  currentStep: BookingFlowStepLike;
  targetSlot: string;
  locale: VoiceLocale;
  overridePrompt?: string;
}): RealtimeMappedStep {
  const { currentStep, targetSlot, locale, overridePrompt } = params;

  const prompt =
    clean(overridePrompt) ||
    buildCurrentStepRetryPrompt({
      currentStep,
      locale,
    }) ||
    resolveLocalizedStepText({
      baseText: clean(currentStep.prompt),
      translations: getStepRecord(currentStep.prompt_translations),
      locale,
    });

  return {
    step_key: clean(currentStep.step_key),
    step_order: Number(currentStep.step_order || 0),
    slot: clean(targetSlot || ""),
    prompt,
    expected_type: clean(currentStep.expected_type),
    required: currentStep.required !== false,
    retry_prompt: clean(currentStep.retry_prompt || ""),
    validation_config: getStepRecord(currentStep.validation_config),
    prompt_translations: getStepRecord(currentStep.prompt_translations),
    retry_prompt_translations: getStepRecord(
      currentStep.retry_prompt_translations
    ),
  };
}

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
  targetSlot: string;
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
    targetSlot,
    currentStep,
    currentIndex,
    workingState,
    bookingContext,
    steps,
    buildRealtimeBookingState,
    persistVoiceState,
  } = params;

  const retryPrompt = buildCurrentStepRetryPrompt({
    currentStep,
    locale: bookingContext.currentLocale,
  });

  const retryState: CallState = {
    ...workingState,
    bookingStepIndex: currentIndex,
    pendingBookingStepKey: clean(currentStep.step_key),
    pendingBookingStepRequired: currentStep.required !== false,
    pendingBookingStepPrompt: retryPrompt,
  };

  Object.assign(bookingContext.state, retryState);

  await persistVoiceState({
    tenantId,
    callSid: bookingContext.callSid,
    state: retryState,
    locale: bookingContext.currentLocale,
  });

  const bookingState = buildRealtimeBookingState({
    steps,
    state: retryState,
    explicitCurrentIndex: currentIndex,
  });

  return {
    ok: false,
    error: "UNRESOLVED_BOOKING_SMS_CONSENT",
    message:
      "The caller's SMS consent answer could not be resolved from the configured booking step.",
    assistant_prompt: retryPrompt,
    booking_state: bookingState,
    next_required_step: mapCurrentStepAsNextRequiredStep({
      currentStep,
      targetSlot,
      locale: bookingContext.currentLocale,
      overridePrompt: retryPrompt,
    }),
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
      targetSlot,
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