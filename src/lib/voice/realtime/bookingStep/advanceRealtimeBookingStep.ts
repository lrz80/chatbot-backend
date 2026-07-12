// src/lib/voice/realtime/bookingStep/advanceRealtimeBookingStep.ts
import type { CallState, VoiceLocale } from "../../types";
import {
  clean,
  buildAnswersBySlot,
  normalizeAnswersToCanonicalSlots,
  type BookingFlowStepLike,
  type BookingState,
} from "../realtimeBookingFlowUtils";
import {
  buildRealtimeNextRequiredStep,
  type RealtimeMappedStep,
} from "./buildRealtimeNextRequiredStep";

type AdvanceRealtimeBookingStepParams = {
  tenantId: string;
  callerPhone: string | null;
  callSid: string;
  currentLocale: VoiceLocale;
  steps: BookingFlowStepLike[];
  currentIndex: number;
  workingState: CallState;
  bookingContextState: CallState;
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

export type AdvanceRealtimeBookingStepResult =
  | {
      ok: true;
      advancedState: CallState;
      booking_state: BookingState;
      next_required_step: RealtimeMappedStep | null;
      assistant_prompt: string;
      action_required: "awaiting_confirmation" | "create_appointment" | null;
    }
  | {
      ok: false;
      error: "BOOKING_STEP_TEMPLATE_INVALID";
      advancedState: CallState;
      booking_state: BookingState;
      next_required_step: null;
      assistant_prompt: "";
      action_required: null;
      step_key: string;
      slot: string;
      prompt_error: string;
      retry_prompt_error: string;
    };

function normalizeKey(value: unknown): string {
  return clean(value).toLowerCase();
}

function hasVerifiedReturningCustomerName(
  state: CallState
): boolean {
  if (state.returningCustomer !== true) {
    return false;
  }

  const crmName = clean(state.returningCustomerName);
  const bookingName = clean(
    state.bookingData?.customer_name
  );

  return Boolean(
    crmName &&
    bookingName &&
    crmName === bookingName
  );
}

function hasVerifiedReturningCustomerPhone(
  state: CallState
): boolean {
  if (state.returningCustomer !== true) {
    return false;
  }

  const crmPhone = clean(state.returningCustomerPhone);
  const bookingPhone = clean(
    state.bookingData?.customer_phone
  );

  return Boolean(
    crmPhone &&
    bookingPhone &&
    crmPhone === bookingPhone
  );
}

function canSkipVerifiedReturningCustomerStep(params: {
  step: BookingFlowStepLike;
  state: CallState;
}): boolean {
  const stepKey = normalizeKey(
    params.step.step_key
  );

  const validationConfig =
    params.step.validation_config &&
    typeof params.step.validation_config === "object"
      ? params.step.validation_config
      : null;

  const slot = normalizeKey(
    validationConfig?.slot || stepKey
  );

  if (
    stepKey === "customer_name" ||
    slot === "customer_name"
  ) {
    return hasVerifiedReturningCustomerName(
      params.state
    );
  }

  if (
    stepKey === "customer_phone" ||
    slot === "customer_phone"
  ) {
    return hasVerifiedReturningCustomerPhone(
      params.state
    );
  }

  return false;
}

function resolveNextBookingStepIndex(params: {
  steps: BookingFlowStepLike[];
  currentIndex: number;
  state: CallState;
}): {
  nextIndex: number | null;
  skippedStepKeys: string[];
} {
  const skippedStepKeys: string[] = [];

  for (
    let index = params.currentIndex + 1;
    index < params.steps.length;
    index += 1
  ) {
    const step = params.steps[index];

    if (
      canSkipVerifiedReturningCustomerStep({
        step,
        state: params.state,
      })
    ) {
      skippedStepKeys.push(
        clean(step.step_key)
      );

      continue;
    }

    return {
      nextIndex: index,
      skippedStepKeys,
    };
  }

  return {
    nextIndex: null,
    skippedStepKeys,
  };
}

export async function advanceRealtimeBookingStep(
  params: AdvanceRealtimeBookingStepParams
): Promise<AdvanceRealtimeBookingStepResult> {
  const {
    tenantId,
    callerPhone,
    callSid,
    currentLocale,
    steps,
    currentIndex,
    workingState,
    buildRealtimeBookingState,
    persistVoiceState,
  } = params;

  const {
    nextIndex,
    skippedStepKeys,
  } = resolveNextBookingStepIndex({
    steps,
    currentIndex,
    state: workingState,
  });

  if (skippedStepKeys.length > 0) {
    console.log(
      "[VOICE_REALTIME][RETURNING_CUSTOMER_IDENTITY_STEPS_SKIPPED]",
      {
        callSid,
        skippedStepKeys,
        returningCustomerContactId:
          workingState.returningCustomerContactId ?? null,
      }
    );
  }

  const advancedState: CallState = {
    ...workingState,
    bookingStepIndex: typeof nextIndex === "number" ? nextIndex : undefined,
  };

  const isFlowComplete = nextIndex === null;

  const finalConfirmationGranted = Boolean(
    clean(advancedState.bookingData?.confirmation) ||
      clean(advancedState.bookingData?.customer_confirmed)
  );

  const bookingState = isFlowComplete
    ? {
        current_step_key: null,
        current_step_slot: null,
        awaiting_confirmation: false,
        final_confirmation_granted: finalConfirmationGranted,
        ready_to_create: finalConfirmationGranted,
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

  const nextRequiredStepResult = isFlowComplete
    ? {
        ok: true as const,
        next_required_step: null,
      }
    : buildRealtimeNextRequiredStep({
        steps,
        bookingState,
        locale: currentLocale,
      });

  if (!nextRequiredStepResult.ok) {
    return {
      ok: false,
      error: nextRequiredStepResult.error,
      advancedState,
      booking_state: bookingState,
      next_required_step: null,
      assistant_prompt: "",
      action_required: null,
      step_key: nextRequiredStepResult.step_key,
      slot: nextRequiredStepResult.slot,
      prompt_error: String(nextRequiredStepResult.prompt_error),
      retry_prompt_error: String(nextRequiredStepResult.retry_prompt_error),
    };
  }

  await persistVoiceState({
    tenantId,
    callSid,
    state: advancedState,
    locale: currentLocale,
  });

  const nextRequiredStep = nextRequiredStepResult.next_required_step;
  const nextStepKey = clean(nextRequiredStep?.step_key || "");

  return {
    ok: true,
    advancedState,
    booking_state: bookingState,
    next_required_step: nextRequiredStep,
    assistant_prompt:
      nextStepKey === "confirm" ? clean(nextRequiredStep?.prompt || "") : "",
    action_required: isFlowComplete
      ? finalConfirmationGranted
        ? "create_appointment"
        : null
      : nextStepKey === "confirm"
        ? "awaiting_confirmation"
        : null,
  };
}