// src/lib/voice/realtime/handlers/handleRealtimeSubmitBookingStep.ts

import type { CallState, VoiceLocale } from "../../types";
import {
  type BookingFlowStepLike,
  type BookingState,
} from "../realtimeBookingFlowUtils";
import { buildRealtimeStepRetryResult } from "../bookingStep/buildRealtimeStepRetryResult";
import { advanceRealtimeBookingStep } from "../bookingStep/advanceRealtimeBookingStep";
import { prepareRealtimeStepSubmission } from "../bookingStep/prepareRealtimeStepSubmission";
import { executeRealtimeStepRoute } from "../bookingStep/executeRealtimeStepRoute";

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
  persistVoiceState: (params: {
    tenantId: string;
    callSid: string;
    state: CallState;
    locale: VoiceLocale;
  }) => Promise<void>;
};

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
    persistVoiceState,
  } = params;

  const prepared = prepareRealtimeStepSubmission({
    callerPhone,
    args,
    bookingContext,
    steps,
    buildRealtimeBookingState,
  });

  if (!prepared.ok) {
    if (
      prepared.result?.ok === false &&
      prepared.result?.currentStep &&
      typeof prepared.result?.currentIndex === "number"
    ) {
      const bookingState = buildRealtimeBookingState({
        steps,
        state: bookingContext.state,
        explicitCurrentIndex: prepared.result.currentIndex,
      });

      return buildRealtimeStepRetryResult({
        error: prepared.result.error,
        currentStep: prepared.result.currentStep,
        currentIndex: prepared.result.currentIndex,
        currentLocale: bookingContext.currentLocale,
        steps,
        bookingState,
      });
    }

    return prepared.result;
  }

  const routeResult = await executeRealtimeStepRoute({
    tenantId,
    callerPhone,
    bookingContext,
    steps,
    currentStep: prepared.currentStep,
    currentIndex: prepared.currentIndex,
    targetSlot: prepared.targetSlot,
    stepKey: prepared.stepKey,
    resolvedInputValue: prepared.resolvedInputValue,
    rawTranscriptValue: prepared.rawTranscriptValue,
    modelValue: prepared.modelValue,
    sanitizedArgs: prepared.sanitizedArgs,
    buildRealtimeBookingState,
    persistVoiceState,
  });

  if (routeResult.kind === "return") {
    return routeResult.result;
  }

  const advanced = await advanceRealtimeBookingStep({
    tenantId,
    callerPhone,
    callSid: bookingContext.callSid,
    currentLocale: bookingContext.currentLocale,
    steps,
    currentIndex: prepared.currentIndex,
    workingState: routeResult.workingState,
    bookingContextState: bookingContext.state,
    buildRealtimeBookingState,
    persistVoiceState,
  });

  if (!advanced.ok) {
    return {
      ok: false,
      error: advanced.error,
      step_key: advanced.step_key,
      slot: advanced.slot,
      prompt_error: advanced.prompt_error,
      retry_prompt_error: advanced.retry_prompt_error,
      message: "BOOKING_FLOW_CONFIGURATION_INVALID",
      booking_state: advanced.booking_state,
      next_required_step: null,
    };
  }

  Object.assign(bookingContext.state, advanced.advancedState);

  return {
    ok: true,
    booking_state: advanced.booking_state,
    next_required_step: advanced.next_required_step,
    assistant_prompt: advanced.assistant_prompt,
    action_required: advanced.action_required,
  };
}