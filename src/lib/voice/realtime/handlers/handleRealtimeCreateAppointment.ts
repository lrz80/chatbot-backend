//src/lib/voice/realtime/handlers/handleRealtimeCreateAppointment.ts
import { executeCanonicalBookingConfirmationStep } from "../../booking/handleBookingConfirmationStep";
import { executeCanonicalBookingSlotBusyRecovery } from "../../voiceBookingBusyRecovery";
import { upsertVoiceCallState } from "../../upsertVoiceCallState";
import type { CallState, VoiceLocale } from "../../types";
import {
  clean,
  getConfirmationLikeStep,
  getStepIndexByKey,
  sortFlowSteps,
  buildAnswersBySlot,
  normalizeAnswersToCanonicalSlots,
  buildCanonicalCallState,
  parseJsonStringArray,
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

type HandleRealtimeCreateAppointmentParams = {
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
};

export async function handleRealtimeCreateAppointment(
  params: HandleRealtimeCreateAppointmentParams
): Promise<any> {
  const {
    tenantId,
    callerPhone,
    args,
    bookingContext,
    steps,
    buildRealtimeBookingState,
    buildNextRequiredStep,
  } = params;

  const confirmationStep = getConfirmationLikeStep(steps);

  if (!confirmationStep) {
    return {
      ok: false,
      error: "BOOKING_CONFIRMATION_STEP_NOT_FOUND",
      message: "No confirmation step is configured in the booking flow.",
    };
  }

  const currentIndex = getStepIndexByKey(
    steps,
    clean(confirmationStep.step_key)
  );

  const answersBySlot = normalizeAnswersToCanonicalSlots({
    steps,
    answersBySlot: buildAnswersBySlot({
      args,
      callerPhone,
      state: bookingContext.state,
    }),
  });

  const workingState = buildCanonicalCallState({
    state: bookingContext.state,
    answersBySlot,
    bookingStepIndex: currentIndex >= 0 ? currentIndex : undefined,
  });

  const confirmationResult = await executeCanonicalBookingConfirmationStep({
    tenant: bookingContext.tenant,
    cfg: bookingContext.cfg,
    flow: steps as any,
    currentStep: confirmationStep as any,
    currentLocale: bookingContext.currentLocale,
    callSid: bookingContext.callSid,
    didNumber: bookingContext.didNumber,
    callerE164: callerPhone,
    userInput: bookingContext.userInput,
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
      explicitCurrentIndex: currentIndex >= 0 ? currentIndex : null,
    });

    return {
      ok: false,
      error: "MISSING_FINAL_CONFIRMATION",
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

    const nextRequiredStep = buildNextRequiredStep({
      steps,
      bookingState,
      locale: bookingContext.currentLocale,
      overridePrompt: confirmationResult.smsOfferPrompt,
    });

    return {
      ok: true,
      message: `${confirmationResult.successPrompt} ${confirmationResult.smsOfferPrompt}`,
      assistant_prompt: clean(nextRequiredStep?.prompt || confirmationResult.smsOfferPrompt),
      booking_outcome: "confirmed_offer_sms",
      booking_state: bookingState,
      next_required_step: nextRequiredStep,
      action_required: "awaiting_offer_booking_sms_confirmation",
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

  return {
    ok: false,
    error: "CREATE_APPOINTMENT_NOT_ALLOWED",
    message: "The appointment could not be created in the current booking state.",
  };
}