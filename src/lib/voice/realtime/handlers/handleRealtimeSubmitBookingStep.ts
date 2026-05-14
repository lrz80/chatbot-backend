//src/lib/voice/realtime/handlers/handleRealtimeSubmitBookingStep.ts
import { executeCanonicalBookingServiceStep } from "../../booking/handleBookingServiceStep";
import { executeCanonicalBookingDatetimeStep } from "../../booking/handleBookingDatetimeStep";
import type { CallState, VoiceLocale } from "../../types";
import {
  clean,
  normalizeComparable,
  getStepSlot,
  canonicalizeGenericStepValue,
  buildAnswersBySlot,
  normalizeAnswersToCanonicalSlots,
  getStepIndexByKey,
  resolveCurrentStepIndex,
  buildCanonicalCallState,
  parseJsonStringArray,
  extractStepOptionCandidates,
  isConfirmationLikeStep,
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

  const providedIndex = getStepIndexByKey(steps, stepKey);

  if (providedIndex === -1) {
    return {
      ok: false,
      error: "UNKNOWN_BOOKING_STEP",
      message: `Unknown booking step: ${stepKey}`,
    };
  }

  const persistedAnswers = normalizeAnswersToCanonicalSlots({
    steps,
    answersBySlot: buildAnswersBySlot({
      args: {},
      callerPhone,
      state: bookingContext.state,
    }),
  });

  const expectedIndex =
    typeof bookingContext.state.bookingStepIndex === "number" &&
    bookingContext.state.bookingStepIndex >= 0 &&
    bookingContext.state.bookingStepIndex < steps.length
      ? bookingContext.state.bookingStepIndex
      : resolveCurrentStepIndex({
          steps,
          state: bookingContext.state,
          answersBySlot: persistedAnswers,
        });

  if (typeof expectedIndex !== "number" || expectedIndex < 0) {
    const bookingState = buildRealtimeBookingState({
      steps,
      state: bookingContext.state,
      explicitCurrentIndex: null,
    });

    return {
      ok: false,
      error: "BOOKING_FLOW_NOT_LOADED",
      message: "Booking flow state is not ready for this realtime call.",
      booking_state: bookingState,
      next_required_step: null,
    };
  }

  if (providedIndex !== expectedIndex) {
    const expectedStep = steps[expectedIndex];

    const bookingState = buildRealtimeBookingState({
      steps,
      state: bookingContext.state,
      explicitCurrentIndex: expectedIndex,
    });

    return {
      ok: false,
      error: "BOOKING_STEP_MISMATCH",
      message: `Received step ${stepKey}, but expected ${clean(
        expectedStep?.step_key
      )}.`,
      expected_step_key: clean(expectedStep?.step_key),
      received_step_key: stepKey,
      booking_state: bookingState,
      next_required_step: buildNextRequiredStep({
        steps,
        bookingState,
        locale: bookingContext.currentLocale,
      }),
    };
  }

  const currentIndex = expectedIndex;
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

  const appointmentAlreadyCreated =
    Boolean(clean(workingState.bookingData?.appointment_id)) ||
    Boolean(clean(workingState.bookingData?.external_calendar_event_id)) ||
    Boolean(clean(workingState.bookingData?.google_event_id)) ||
    Boolean(clean(workingState.bookingData?.google_event_link));

  const isPostBookingStep =
    appointmentAlreadyCreated &&
    clean(currentStep.expected_type) === "confirmation";

  const isFinalConfirmationBeforeCreate =
    !appointmentAlreadyCreated && isConfirmationLikeStep(currentStep);

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
  } else if (isPostBookingStep) {
    const normalizedStepValue = canonicalizeGenericStepValue(currentStep, value);

    const storageSlot =
      targetSlot && targetSlot !== "none" ? targetSlot : stepKey;

    const nextAnswers = {
      ...rawAnswers,
      [storageSlot]: normalizedStepValue,
      [stepKey]: normalizedStepValue,
    };

    workingState = buildCanonicalCallState({
      state: workingState,
      answersBySlot: nextAnswers,
      bookingStepIndex: currentIndex,
    });
  } else if (isFinalConfirmationBeforeCreate) {
    const normalizedStepValue = canonicalizeGenericStepValue(currentStep, value);

    const storageSlot =
      targetSlot && targetSlot !== "none" ? targetSlot : stepKey;

    const nextAnswers = {
      ...rawAnswers,
      [storageSlot]: normalizedStepValue,
      [stepKey]: normalizedStepValue,
    };

    const confirmationState = buildCanonicalCallState({
      state: workingState,
      answersBySlot: nextAnswers,
      bookingStepIndex: currentIndex,
    });

    Object.assign(bookingContext.state, confirmationState);

    await persistVoiceState({
      tenantId,
      callSid: bookingContext.callSid,
      state: confirmationState,
      locale: bookingContext.currentLocale,
    });

    const bookingState = buildRealtimeBookingState({
      steps,
      state: confirmationState,
      explicitCurrentIndex: null,
      finalConfirmationGranted: true,
      readyToCreate: true,
    });

    return {
      ok: true,
      booking_state: bookingState,
      next_required_step: null,
      assistant_prompt: "",
      action_required: "create_appointment",
    };
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

    const validationMode = clean(currentStep.validation_config?.mode);
    const useInboundCaller =
      currentStep.validation_config?.use_inbound_caller === true;

    let resolvedStepValue = normalizedStepValue;

    if (
      targetSlot === "customer_phone" &&
      validationMode === "confirm_or_replace" &&
      useInboundCaller
    ) {
      const existingPhone =
        clean(rawAnswers.customer_phone) || clean(callerPhone);

      const digitsOnly = clean(value).replace(/\D+/g, "");

      if (digitsOnly.length >= 7) {
        resolvedStepValue = clean(value);
      } else if (existingPhone) {
        resolvedStepValue = existingPhone;
      }
    }

    const nextAnswers = {
      ...rawAnswers,
      [targetSlot]: resolvedStepValue,
      [stepKey]: resolvedStepValue,
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

  Object.assign(bookingContext.state, advancedState);

  await persistVoiceState({
    tenantId,
    callSid: bookingContext.callSid,
    state: advancedState,
    locale: bookingContext.currentLocale,
  });

  const isFlowComplete = nextIndex === null;

  const bookingState = isFlowComplete
    ? {
        current_step_key: null,
        current_step_slot: null,
        awaiting_confirmation: false,
        final_confirmation_granted: Boolean(
          clean(advancedState.bookingData?.confirmation) ||
            clean(advancedState.bookingData?.customer_confirmed)
        ),
        ready_to_create: false,
        collected_slots: normalizeAnswersToCanonicalSlots({
          steps,
          answersBySlot: buildAnswersBySlot({
            args: {},
            callerPhone,
            state: advancedState,
          }),
        }),
      }
    : buildRealtimeBookingState({
        steps,
        state: advancedState,
        explicitCurrentIndex: nextIndex,
      });

  const nextRequiredStep = isFlowComplete
    ? null
    : buildNextRequiredStep({
        steps,
        bookingState,
        locale: bookingContext.currentLocale,
      });

  const nextStepKey = clean(nextRequiredStep?.step_key || "");

  return {
    ok: true,
    booking_state: bookingState,
    next_required_step: nextRequiredStep,
    assistant_prompt:
      nextStepKey === "confirm" ? clean(nextRequiredStep?.prompt || "") : "",
    action_required:
      nextStepKey === "confirm" ? "awaiting_confirmation" : null,
  };
}