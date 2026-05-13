//src/lib/voice/realtime/handlers/handleRealtimeSubmitBookingStep.ts
import { executeCanonicalBookingServiceStep } from "../../booking/handleBookingServiceStep";
import { executeCanonicalBookingDatetimeStep } from "../../booking/handleBookingDatetimeStep";
import { executeCanonicalBookingConfirmationStep } from "../../booking/handleBookingConfirmationStep";
import { executeCanonicalBookingSlotBusyRecovery } from "../../voiceBookingBusyRecovery";
import { upsertVoiceCallState } from "../../upsertVoiceCallState";
import type { CallState, VoiceLocale } from "../../types";
import {
  clean,
  normalizeComparable,
  getStepSlot,
  isConfirmationLikeStep,
  canonicalizeGenericStepValue,
  buildAnswersBySlot,
  normalizeAnswersToCanonicalSlots,
  getStepIndexByKey,
  buildCanonicalCallState,
  parseJsonStringArray,
  extractStepOptionCandidates,
  type BookingFlowStepLike,
  type BookingState,
} from "../realtimeBookingFlowUtils";

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

  if (!stepKey) {
    return {
      ok: false,
      error: "MISSING_STEP_KEY",
      message: "step_key is required.",
    };
  }

  const currentIndex = getStepIndexByKey(steps, stepKey);
  if (currentIndex === -1) {
    return {
      ok: false,
      error: "UNKNOWN_BOOKING_STEP",
      message: `Unknown booking step: ${stepKey}`,
    };
  }

  const currentStep = steps[currentIndex];
  const targetSlot = getStepSlot(currentStep);

  if (!targetSlot) {
    return {
      ok: false,
      error: "BOOKING_STEP_WITHOUT_SLOT",
      message: `Booking step ${stepKey} has no canonical slot.`,
    };
  }

  const rawAnswers = normalizeAnswersToCanonicalSlots({
    steps,
    answersBySlot: buildAnswersBySlot({
      args,
      callerPhone,
      state: bookingContext.state,
    }),
  });

  let workingState = buildCanonicalCallState({
    state: bookingContext.state,
    answersBySlot: rawAnswers,
    bookingStepIndex: currentIndex,
  });

  const rawSlot =
    typeof currentStep.validation_config?.slot === "string"
      ? currentStep.validation_config.slot.trim()
      : "";

  const isServiceStep =
    clean(currentStep.step_key) === "service" || rawSlot === "service";

  const isDatetimeStep =
    clean(currentStep.step_key) === "datetime" || rawSlot === "datetime";

  const isConfirmationStep = isConfirmationLikeStep(currentStep);

  if (isServiceStep) {
    const serviceResult = await executeCanonicalBookingServiceStep({
      currentStep: currentStep as any,
      currentLocale: bookingContext.currentLocale,
      callerE164: callerPhone,
      effectiveUserInput: value,
      state: workingState,
      rawConfig: bookingContext.cfg?.booking_services_text || "",
    });

    if (serviceResult.kind === "retry" || serviceResult.kind === "ambiguous") {
      const bookingState = buildRealtimeBookingState({
        steps,
        state: workingState,
        explicitCurrentIndex: currentIndex,
      });

      return {
        ok: false,
        error:
          serviceResult.kind === "ambiguous"
            ? "AMBIGUOUS_BOOKING_SERVICE"
            : "UNRESOLVED_BOOKING_SERVICE",
        message: serviceResult.prompt,
        assistant_prompt: serviceResult.prompt,
        booking_state: bookingState,
        next_required_step: buildNextRequiredStep({
          steps,
          bookingState,
          locale: bookingContext.currentLocale,
          overridePrompt: serviceResult.prompt,
        }),
        service_options:
          serviceResult.kind === "ambiguous" ? serviceResult.options : [],
      };
    }

    const nextAnswers = {
      ...rawAnswers,
      [targetSlot]: serviceResult.resolvedValue,
      [stepKey]: serviceResult.resolvedValue,
    };

    workingState = buildCanonicalCallState({
      state: serviceResult.state,
      answersBySlot: nextAnswers,
      bookingStepIndex: currentIndex,
    });
  } else if (isDatetimeStep) {
    const datetimeResult = await executeCanonicalBookingDatetimeStep({
      tenantId,
      callSid: bookingContext.callSid,
      currentStep: currentStep as any,
      currentIndex,
      currentLocale: bookingContext.currentLocale,
      callerE164: callerPhone,
      state: workingState,
      resolvedStepValue: value,
    });

    if (datetimeResult.kind === "retry") {
      const retryState = datetimeResult.state;
      const bookingState = buildRealtimeBookingState({
        steps,
        state: retryState,
        explicitCurrentIndex: currentIndex,
      });

      return {
        ok: false,
        error:
          datetimeResult.context === "slot_unavailable"
            ? "SLOT_UNAVAILABLE"
            : "INVALID_DATETIME_STEP",
        message: datetimeResult.prompt,
        assistant_prompt: datetimeResult.prompt,
        suggested_times: parseJsonStringArray(
          retryState.bookingData?.__datetime_reference_suggested_starts
        ),
        booking_state: bookingState,
        next_required_step: buildNextRequiredStep({
          steps,
          bookingState,
          locale: bookingContext.currentLocale,
          overridePrompt: datetimeResult.prompt,
        }),
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
      datetime_iso: clean(
        datetimeResult.nextState.bookingData?.datetime_iso || ""
      ),
      datetime_display: clean(
        datetimeResult.nextState.bookingData?.datetime_display ||
          datetimeResult.resolvedValue
      ),
    };

    workingState = buildCanonicalCallState({
      state: datetimeResult.nextState,
      answersBySlot: nextAnswers,
      bookingStepIndex: currentIndex,
    });
  } else if (isConfirmationStep) {
    const confirmationResult = await executeCanonicalBookingConfirmationStep({
      tenant: bookingContext.tenant,
      cfg: bookingContext.cfg,
      flow: steps as any,
      currentStep: currentStep as any,
      currentLocale: bookingContext.currentLocale,
      callSid: bookingContext.callSid,
      didNumber: bookingContext.didNumber,
      callerE164: callerPhone,
      userInput: bookingContext.userInput || value,
      digits: bookingContext.digits,
      state: workingState,
      upsertVoiceCallState,
    });

    if (confirmationResult.kind === "busy_recovery") {
      const busyRecovered = await executeCanonicalBookingSlotBusyRecovery({
        flow: steps as any,
        state: confirmationResult.state,
        tenantId,
        callSid: bookingContext.callSid,
        currentLocale: bookingContext.currentLocale,
        callerE164: callerPhone,
        timeZone: confirmationResult.busyRecovery.timeZone,
        suggestedStarts: confirmationResult.busyRecovery.suggestedStarts,
      });

      const bookingState = buildRealtimeBookingState({
        steps,
        state: busyRecovered.state,
        explicitCurrentIndex: busyRecovered.datetimeStepIndex,
      });

      return {
        ok: false,
        error: "SLOT_UNAVAILABLE",
        message: busyRecovered.prompt,
        assistant_prompt: busyRecovered.prompt,
        suggested_times: parseJsonStringArray(
          busyRecovered.state.bookingData?.__booking_busy_suggested_starts
        ),
        booking_state: bookingState,
        next_required_step: buildNextRequiredStep({
          steps,
          bookingState,
          locale: bookingContext.currentLocale,
          overridePrompt: busyRecovered.prompt,
        }),
      };
    }

    if (confirmationResult.kind === "retry") {
      const bookingState = buildRealtimeBookingState({
        steps,
        state: confirmationResult.state,
        explicitCurrentIndex: currentIndex,
      });

      return {
        ok: false,
        error: "CONFIRMATION_RETRY",
        message: confirmationResult.prompt,
        assistant_prompt: confirmationResult.prompt,
        booking_state: bookingState,
        next_required_step: buildNextRequiredStep({
          steps,
          bookingState,
          locale: bookingContext.currentLocale,
          overridePrompt: confirmationResult.prompt,
        }),
      };
    }

    if (confirmationResult.kind === "failed") {
      const bookingState = buildRealtimeBookingState({
        steps,
        state: confirmationResult.state,
        explicitCurrentIndex: null,
      });

      return {
        ok: false,
        error: "BOOKING_FAILED",
        message: confirmationResult.prompt,
        assistant_prompt: confirmationResult.prompt,
        booking_outcome: "failed",
        booking_state: bookingState,
        next_required_step: null,
      };
    }

    if (confirmationResult.kind === "cancelled") {
      const bookingState = buildRealtimeBookingState({
        steps,
        state: confirmationResult.state,
        explicitCurrentIndex: null,
      });

      return {
        ok: true,
        message: confirmationResult.prompt,
        assistant_prompt: confirmationResult.prompt,
        booking_outcome: "cancelled",
        booking_state: bookingState,
        next_required_step: null,
      };
    }

    if (confirmationResult.kind === "awaiting_sms_destination") {
      const bookingState = buildRealtimeBookingState({
        steps,
        state: confirmationResult.state,
        explicitCurrentIndex: null,
      });

      return {
        ok: true,
        booking_outcome: "awaiting_sms_destination",
        requires_sms_destination: true,
        booking_state: bookingState,
        next_required_step: null,
      };
    }

    if (confirmationResult.kind === "success_offer_sms") {
      const bookingState = buildRealtimeBookingState({
        steps,
        state: confirmationResult.state,
        explicitCurrentIndex:
          typeof confirmationResult.state.bookingStepIndex === "number"
            ? confirmationResult.state.bookingStepIndex
            : null,
      });

      return {
        ok: true,
        message: `${confirmationResult.successPrompt} ${confirmationResult.smsOfferPrompt}`,
        assistant_prompt: `${confirmationResult.successPrompt} ${confirmationResult.smsOfferPrompt}`,
        booking_outcome: "confirmed_offer_sms",
        booking_state: bookingState,
        next_required_step: buildNextRequiredStep({
          steps,
          bookingState,
          locale: bookingContext.currentLocale,
          overridePrompt: confirmationResult.smsOfferPrompt,
        }),
      };
    }

    if (confirmationResult.kind === "success") {
      const bookingState = buildRealtimeBookingState({
        steps,
        state: confirmationResult.state,
        explicitCurrentIndex: null,
      });

      return {
        ok: true,
        message: confirmationResult.prompt,
        assistant_prompt: confirmationResult.prompt,
        booking_outcome: "confirmed",
        booking_state: bookingState,
        next_required_step: null,
      };
    }

    if (confirmationResult.kind === "pass_through") {
      const bookingState = buildRealtimeBookingState({
        steps,
        state: confirmationResult.state,
        explicitCurrentIndex: currentIndex,
      });

      return {
        ok: false,
        error: "INVALID_CONFIRMATION_STEP",
        message: "Confirmation step could not be processed.",
        booking_state: bookingState,
        next_required_step: buildNextRequiredStep({
          steps,
          bookingState,
          locale: bookingContext.currentLocale,
        }),
      };
    }
  } else {
    const normalizedStepValue = canonicalizeGenericStepValue(currentStep, value);
    const optionCandidates = extractStepOptionCandidates(currentStep);
    const hasConfiguredOptions = optionCandidates.length > 0;

    if (hasConfiguredOptions) {
      const resolvedToConfiguredOption = optionCandidates.some(
        (option) =>
          normalizeComparable(option.canonical) ===
          normalizeComparable(normalizedStepValue)
      );

      if (!resolvedToConfiguredOption) {
        const bookingState = buildRealtimeBookingState({
          steps,
          state: workingState,
          explicitCurrentIndex: currentIndex,
        });

        return {
          ok: false,
          error: "UNRESOLVED_STEP_OPTION",
          message:
            "The requested value could not be resolved to a configured canonical option.",
          booking_state: bookingState,
          next_required_step: buildNextRequiredStep({
            steps,
            bookingState,
            locale: bookingContext.currentLocale,
          }),
        };
      }
    }

    const nextAnswers = {
      ...rawAnswers,
      [targetSlot]: normalizedStepValue,
      [stepKey]: normalizedStepValue,
    };

    workingState = buildCanonicalCallState({
      state: workingState,
      answersBySlot: nextAnswers,
      bookingStepIndex: currentIndex,
    });
  }

  const nextIndex = currentIndex + 1 < steps.length ? currentIndex + 1 : null;

  const advancedState: CallState = {
    ...workingState,
    bookingStepIndex:
      typeof nextIndex === "number" ? nextIndex : undefined,
  };

  await persistVoiceState({
    tenantId,
    callSid: bookingContext.callSid,
    state: advancedState,
    locale: bookingContext.currentLocale,
  });

  const bookingState = buildRealtimeBookingState({
    steps,
    state: advancedState,
    explicitCurrentIndex: nextIndex,
  });

  return {
    ok: true,
    booking_state: bookingState,
    next_required_step: buildNextRequiredStep({
      steps,
      bookingState,
      locale: bookingContext.currentLocale,
    }),
    action_required: null,
  };
}