//src/lib/voice/realtime/handlers/handleRealtimeSubmitBookingStep.ts
import type { CallState, VoiceLocale } from "../../types";
import {
  clean,
  getStepSlot,
  renderBookingStepTemplate,
  buildBookingPromptTemplateValues,
  type BookingFlowStepLike,
  type BookingState,
} from "../realtimeBookingFlowUtils";
import { handlePostBookingSmsConsentStep } from "./handlePostBookingSmsConsentStep";
import { handleFinalBookingConfirmationStep } from "./handleFinalBookingConfirmationStep";
import { handlePostBookingGenericStep } from "./handlePostBookingGenericStep";
import { handleBookingServiceRealtimeStep } from "./handleBookingServiceRealtimeStep";
import { resolveRealtimeSubmittedStepValue } from "../bookingStep/resolveRealtimeSubmittedStepValue";
import { advanceRealtimeBookingStep } from "../bookingStep/advanceRealtimeBookingStep";
import { routeRealtimeBookingStep } from "../bookingStep/routeRealtimeBookingStep";
import { handleGenericRealtimeStep } from "../bookingStep/handlers/handleGenericRealtimeStep";
import { handleDatetimeRealtimeStep } from "../bookingStep/handlers/handleDatetimeRealtimeStep";
import { buildRealtimeStepRetryResult } from "../bookingStep/buildRealtimeStepRetryResult";
import { resolveExpectedRealtimeBookingStep } from "../bookingStep/resolveExpectedRealtimeBookingStep";
import { buildRealtimeStepWorkingState } from "../bookingStep/buildRealtimeStepWorkingState";
import { handleStaffRealtimeStep } from "../bookingStep/handlers/handleStaffRealtimeStep";

type RealtimeBookingContext = {
  tenant: any;
  cfg: any;
  callSid: string;
  didNumber: string;
  currentLocale: VoiceLocale;
  state: CallState;
  userInput: string;
  digits: string;
};

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

type HandleRealtimeSubmitBookingStepParams = {
  tenantId: string;
  callerPhone: string | null;
  args: Record<string, any>;
  bookingContext: RealtimeBookingContext;
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
  persistVoiceState: (params: {
    tenantId: string;
    callSid: string;
    state: CallState;
    locale: VoiceLocale;
  }) => Promise<void>;
};

function getRecordValue(
  record: Record<string, unknown> | null | undefined,
  key: string
): string {
  const value = record?.[key];
  return typeof value === "string" ? clean(value) : "";
}

function resolveConfiguredUnavailablePrompt(params: {
  step: BookingFlowStepLike;
  locale: VoiceLocale;
}): string {
  const validationConfig =
    params.step.validation_config &&
    typeof params.step.validation_config === "object"
      ? (params.step.validation_config as Record<string, unknown>)
      : {};

  const translations =
    validationConfig.unavailable_prompt_translations &&
    typeof validationConfig.unavailable_prompt_translations === "object"
      ? (validationConfig.unavailable_prompt_translations as Record<string, unknown>)
      : {};

  const translatedPrompt = getRecordValue(translations, params.locale);

  if (translatedPrompt) {
    return translatedPrompt;
  }

  const baseUnavailablePrompt = getRecordValue(
    validationConfig,
    "unavailable_prompt"
  );

  return baseUnavailablePrompt;
}

export async function handleRealtimeSubmitBookingStep(
  params: HandleRealtimeSubmitBookingStepParams
): Promise<any> {
  const {
    tenantId,
    callerPhone,
    args,
    bookingContext,
    steps,
    buildRealtimeBookingState,
    buildNextRequiredStep,
    persistVoiceState,
  } = params;

  const stepKey = clean(args.step_key);

  const value = clean(args.value);

  const modelValue = clean(args.model_value || args.value);

  const rawTranscriptValue = clean(
    args.raw_transcript_value ||
      args.transcript_value ||
      bookingContext.userInput
  );

  if (!stepKey) {
    return {
      ok: false,
      error: "MISSING_STEP_KEY",
      message: "step_key is required.",
    };
  }

  const expectedStepResolution = resolveExpectedRealtimeBookingStep({
    stepKey,
    steps,
    state: bookingContext.state,
    callerPhone,
    currentLocale: bookingContext.currentLocale,
    buildRealtimeBookingState,
    buildNextRequiredStep,
  });

  if (!expectedStepResolution.ok) {
    return expectedStepResolution.result;
  }

  const currentIndex = expectedStepResolution.currentIndex;
  const currentStep = expectedStepResolution.currentStep;

  const targetSlot = getStepSlot(currentStep);

  if (!targetSlot) {
    return {
      ok: false,
      error: "BOOKING_STEP_WITHOUT_SLOT",
      message: `Booking step ${stepKey} has no canonical slot.`,
    };
  }

  const stepWorkingState = buildRealtimeStepWorkingState({
    args,
    callerPhone,
    state: bookingContext.state,
    steps,
    currentIndex,
  });

  const rawAnswers = stepWorkingState.rawAnswers;
  let workingState = stepWorkingState.workingState;

  const stepRoute = routeRealtimeBookingStep({
    currentStep,
    workingState,
  });

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
  });

  if (!submittedStepValue.ok) {
    const bookingState = buildRealtimeBookingState({
      steps,
      state: workingState,
      explicitCurrentIndex: currentIndex,
    });

    return buildRealtimeStepRetryResult({
      error: submittedStepValue.error,
      currentStep,
      currentIndex,
      currentLocale: bookingContext.currentLocale,
      steps,
      bookingState,
      buildNextRequiredStep,
    });
  }

  const resolvedInputValue = submittedStepValue.value;

  if (stepRoute.kind === "service") {
    const serviceStepResult = await handleBookingServiceRealtimeStep({
      callerPhone,
      currentStep,
      currentIndex,
      currentLocale: bookingContext.currentLocale,
      value: resolvedInputValue,
      targetSlot,
      stepKey,
      rawAnswers,
      workingState,
      rawConfig: bookingContext.cfg?.booking_services_text || "",
      steps,
      buildRealtimeBookingState,
      buildNextRequiredStep,
    });

    if (serviceStepResult.kind === "return") {
      return serviceStepResult.result;
    }

    workingState = serviceStepResult.workingState;

  } else if (stepRoute.kind === "datetime") {
    const datetimeStepResult = await handleDatetimeRealtimeStep({
      tenantId,
      callSid: bookingContext.callSid,
      callerPhone,
      currentStep,
      currentIndex,
      currentLocale: bookingContext.currentLocale,
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
    });

    if (datetimeStepResult.kind === "return") {
      return datetimeStepResult.result;
    }

    workingState = datetimeStepResult.workingState;

  } else if (stepRoute.kind === "staff") {
    const staffStepResult = await handleStaffRealtimeStep({
      tenantId,
      currentStep,
      currentIndex,
      currentLocale: bookingContext.currentLocale,
      targetSlot,
      stepKey,
      resolvedInputValue,
      rawAnswers,
      workingState,
      steps,
      buildRealtimeBookingState,
      buildNextRequiredStep,
    });

    if (staffStepResult.kind === "return") {
      return staffStepResult.result;
    }

    workingState = staffStepResult.workingState;

  } else if (stepRoute.kind === "post_booking_sms_consent") {
    return await handlePostBookingSmsConsentStep({
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
    });

  } else if (stepRoute.kind === "post_booking_generic") {
    workingState = handlePostBookingGenericStep({
      stepKey,
      targetSlot,
      currentStep,
      currentIndex,
      rawAnswers,
      workingState,
      value: resolvedInputValue,
    });

  } else if (stepRoute.kind === "final_confirmation_before_create") {
    return await handleFinalBookingConfirmationStep({
      tenantId,
      stepKey,
      targetSlot,
      currentStep,
      currentIndex,
      rawAnswers,
      workingState,
      bookingContext,
      steps,
      value: resolvedInputValue,
      buildRealtimeBookingState,
      persistVoiceState,
    });
  } else {
    const genericStepResult = handleGenericRealtimeStep({
      currentStep,
      currentIndex,
      currentLocale: bookingContext.currentLocale,
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
    });

    if (genericStepResult.kind === "return") {
      return genericStepResult.result;
    }

    workingState = genericStepResult.workingState;
  }

  const advanced = await advanceRealtimeBookingStep({
    tenantId,
    callerPhone,
    callSid: bookingContext.callSid,
    currentLocale: bookingContext.currentLocale,
    steps,
    currentIndex,
    workingState,
    bookingContextState: bookingContext.state,
    buildRealtimeBookingState,
    buildNextRequiredStep,
    persistVoiceState,
  });

  Object.assign(bookingContext.state, advanced.advancedState);

  return {
    ok: true,
    booking_state: advanced.booking_state,
    next_required_step: advanced.next_required_step,
    assistant_prompt: advanced.assistant_prompt,
    action_required: advanced.action_required,
  };
}