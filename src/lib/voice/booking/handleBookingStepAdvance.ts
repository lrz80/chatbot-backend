// src/lib/voice/booking/handleBookingStepAdvance.ts
import { twiml } from "twilio";
import {
  resolveBookingFlowSpeech,
  resolveBookingPromptText,
  resolveBookingRetryText,
} from "../voiceBookingHelpers";
import { twoSentencesMax } from "../speechFormatting";
import { deleteVoiceCallState } from "../deleteVoiceCallState";
import { assertNonEmptyBookingSpeech } from "./bookingSpeech";
import type {
  BookingFlow,
  BookingStep,
  BookingStepHandlerResult,
  CreateBookingGatherFn,
} from "./types";
import type { CallState, VoiceLocale } from "../types";

type HandleBookingStepAdvanceParams = {
  vr: twiml.VoiceResponse;
  tenantId: string;
  flow: BookingFlow;
  currentStep: BookingStep;
  currentIndex: number;
  currentLocale: VoiceLocale;
  voiceName: any;
  callSid: string;
  callerE164: string | null;
  state: CallState;
  resolvedStepValue: string;
  isServiceStep?: boolean;
  isDatetimeStep?: boolean;
  createBookingGather: CreateBookingGatherFn;
  upsertVoiceCallState: typeof import("../upsertVoiceCallState").upsertVoiceCallState;
};

type StepValidationResult =
  | {
      ok: true;
      value: string;
    }
  | {
      ok: false;
      reason: "required_empty" | "too_short" | "not_allowed_option";
    };

function normalizeStepValue(value: unknown): string {
  return String(value || "")
    .normalize("NFKC")
    .trim();
}

function normalizeComparableValue(value: unknown): string {
  return normalizeStepValue(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ");
}

function getValidationConfig(currentStep: BookingStep): Record<string, any> {
  const raw = currentStep.validation_config;

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  return raw as Record<string, any>;
}

function resolveIsRequired(currentStep: BookingStep): boolean {
  const validationConfig = getValidationConfig(currentStep);

  if (typeof validationConfig.required === "boolean") {
    return validationConfig.required;
  }

  const rawRequired = (currentStep as any).required;

  if (typeof rawRequired === "boolean") {
    return rawRequired;
  }

  return true;
}

function resolveMinLength(currentStep: BookingStep): number {
  const validationConfig = getValidationConfig(currentStep);

  const rawMinLength =
    validationConfig.min_length ??
    validationConfig.minLength ??
    validationConfig.minimum_length ??
    validationConfig.minimumLength;

  const parsed = Number(rawMinLength);

  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }

  return 1;
}

function extractOptionValue(option: unknown): string | null {
  if (typeof option === "string" || typeof option === "number") {
    const value = normalizeStepValue(option);

    return value || null;
  }

  if (!option || typeof option !== "object" || Array.isArray(option)) {
    return null;
  }

  const record = option as Record<string, any>;

  const value =
    record.value ??
    record.id ??
    record.key ??
    record.label ??
    record.name ??
    record.title;

  const normalized = normalizeStepValue(value);

  return normalized || null;
}

function resolveConfiguredOptions(currentStep: BookingStep): string[] {
  const validationConfig = getValidationConfig(currentStep);

  const optionSources = [
    validationConfig.options,
    validationConfig.allowed_values,
    validationConfig.allowedValues,
    validationConfig.choices,
    validationConfig.enum,
    validationConfig.values,
    (currentStep as any).options,
    (currentStep as any).choices,
  ];

  const values: string[] = [];

  for (const source of optionSources) {
    if (!Array.isArray(source)) {
      continue;
    }

    for (const option of source) {
      const value = extractOptionValue(option);

      if (value) {
        values.push(value);
      }
    }
  }

  return Array.from(new Set(values));
}

function validateResolvedStepValue(params: {
  currentStep: BookingStep;
  resolvedStepValue: string;
}): StepValidationResult {
  const { currentStep, resolvedStepValue } = params;

  const value = normalizeStepValue(resolvedStepValue);
  const isRequired = resolveIsRequired(currentStep);
  const minLength = resolveMinLength(currentStep);
  const configuredOptions = resolveConfiguredOptions(currentStep);

  if (!value) {
    if (isRequired) {
      return {
        ok: false,
        reason: "required_empty",
      };
    }

    return {
      ok: true,
      value,
    };
  }

  if (value.length < minLength) {
    return {
      ok: false,
      reason: "too_short",
    };
  }

  if (configuredOptions.length > 0) {
    const normalizedValue = normalizeComparableValue(value);

    const matchesConfiguredOption = configuredOptions.some((option) => {
      return normalizeComparableValue(option) === normalizedValue;
    });

    if (!matchesConfiguredOption) {
      return {
        ok: false,
        reason: "not_allowed_option",
      };
    }
  }

  return {
    ok: true,
    value,
  };
}

function buildCurrentStepRetryPrompt(params: {
  currentStep: BookingStep;
  currentLocale: VoiceLocale;
  bookingData: CallState["bookingData"];
  callerE164: string | null;
}): string {
  const { currentStep, currentLocale, bookingData, callerE164 } = params;

  const retryPromptText = resolveBookingRetryText({
    locale: currentLocale,
    retryPrompt: currentStep.retry_prompt || "",
    retryPromptTranslations: currentStep.retry_prompt_translations || null,
    fallbackPrompt: currentStep.prompt || "",
    fallbackPromptTranslations: currentStep.prompt_translations || null,
  });

  const retryPromptResolved = resolveBookingFlowSpeech({
    baseText: retryPromptText,
    locale: currentLocale,
    bookingData: bookingData || {},
    callerE164,
  });

  return twoSentencesMax(
    assertNonEmptyBookingSpeech({
      text: retryPromptResolved,
      stepKey: currentStep.step_key,
      field: "retry_prompt",
    })
  );
}

async function persistCurrentStepRetryState(params: {
  tenantId: string;
  callSid: string;
  currentLocale: VoiceLocale;
  currentIndex: number;
  state: CallState;
  upsertVoiceCallState: HandleBookingStepAdvanceParams["upsertVoiceCallState"];
}): Promise<CallState> {
  const {
    tenantId,
    callSid,
    currentLocale,
    currentIndex,
    state,
    upsertVoiceCallState,
  } = params;

  const nextState: CallState = {
    ...state,
    bookingStepIndex: currentIndex,
    bookingData: state.bookingData || {},
  };

  await upsertVoiceCallState({
    callSid,
    tenantId,
    lang: nextState.lang ?? currentLocale,
    turn: nextState.turn ?? 0,
    awaiting: nextState.awaiting ?? false,
    pendingType: nextState.pendingType ?? null,
    awaitingNumber: nextState.awaitingNumber ?? false,
    altDest: nextState.altDest ?? null,
    smsSent: nextState.smsSent ?? false,
    bookingStepIndex: currentIndex,
    bookingData: nextState.bookingData || {},
  });

  return nextState;
}

export async function handleBookingStepAdvance(
  params: HandleBookingStepAdvanceParams
): Promise<BookingStepHandlerResult> {
  const {
    vr,
    tenantId,
    flow,
    currentStep,
    currentIndex,
    currentLocale,
    voiceName,
    callSid,
    callerE164,
    state,
    resolvedStepValue,
    isServiceStep = false,
    isDatetimeStep = false,
    createBookingGather,
    upsertVoiceCallState,
  } = params;

  const validation = validateResolvedStepValue({
    currentStep,
    resolvedStepValue,
  });

  if (!validation.ok) {
    const retryPrompt = buildCurrentStepRetryPrompt({
      currentStep,
      currentLocale,
      bookingData: state.bookingData,
      callerE164,
    });

    const retryState = await persistCurrentStepRetryState({
      tenantId,
      callSid,
      currentLocale,
      currentIndex,
      state,
      upsertVoiceCallState,
    });

    const isPhoneStep = currentStep.expected_type === "phone";
    const isConfirmationStep = currentStep.expected_type === "confirmation";

    const gather = createBookingGather({
      vr,
      locale: currentLocale,
      isPhoneStep,
      isConfirmationStep,
    });

    gather.say({ language: currentLocale as any, voice: voiceName }, retryPrompt);

    return {
      handled: true,
      state: retryState,
      twiml: vr.toString(),
    };
  }

  const nextData: Record<string, string> = {
    ...(state.bookingData || {}),
    [currentStep.step_key]: validation.value,
    ...(isServiceStep
      ? {
          service_display: String(
            state.bookingData?.service_display || validation.value || ""
          ).trim(),
        }
      : {}),
    ...(isDatetimeStep
      ? {
          datetime_display: validation.value,
        }
      : {}),
  };

  if (isDatetimeStep) {
    delete nextData.__datetime_reference_suggested_starts;
  }

  const nextIndex = currentIndex + 1;
  const nextStep = flow[nextIndex];

  if (!nextStep) {
    await deleteVoiceCallState(callSid);
    throw new Error("BOOKING_CONFIRM_STEP_MISSING");
  }

  const nextStepPromptText = resolveBookingPromptText({
    locale: currentLocale,
    prompt: nextStep.prompt || "",
    promptTranslations: nextStep.prompt_translations || null,
  });

  const promptResolved = resolveBookingFlowSpeech({
    baseText: nextStepPromptText,
    locale: currentLocale,
    bookingData: nextData,
    callerE164,
  });

  const prompt = twoSentencesMax(
    assertNonEmptyBookingSpeech({
      text: promptResolved,
      stepKey: nextStep.step_key,
      field: "prompt",
    })
  );

  const nextState: CallState = {
    ...state,
    bookingStepIndex: nextIndex,
    bookingData: nextData,
  };

  await upsertVoiceCallState({
    callSid,
    tenantId,
    lang: nextState.lang ?? currentLocale,
    turn: nextState.turn ?? 0,
    awaiting: nextState.awaiting ?? false,
    pendingType: nextState.pendingType ?? null,
    awaitingNumber: nextState.awaitingNumber ?? false,
    altDest: nextState.altDest ?? null,
    smsSent: nextState.smsSent ?? false,
    bookingStepIndex: nextIndex,
    bookingData: nextData,
  });

  const isPhoneStep = nextStep.expected_type === "phone";
  const isConfirmationStep = nextStep.expected_type === "confirmation";

  const gather = createBookingGather({
    vr,
    locale: currentLocale,
    isPhoneStep,
    isConfirmationStep,
  });

  gather.say({ language: currentLocale as any, voice: voiceName }, prompt);

  return {
    handled: true,
    state: nextState,
    twiml: vr.toString(),
  };
}