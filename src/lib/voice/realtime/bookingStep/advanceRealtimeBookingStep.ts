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
      action_required:
        | "awaiting_confirmation"
        | "create_appointment"
        | null;
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

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

/**
 * Confirmation and post-booking choices must remain explicit.
 *
 * Even if a similarly named value exists in bookingData, these steps
 * should still be presented to the caller during the current booking.
 */
function isExplicitInteractionStep(
  step: BookingFlowStepLike | null | undefined
): boolean {
  const stepKey = normalizeKey((step as any)?.step_key);
  const slot = normalizeKey((step as any)?.slot);
  const expectedType = normalizeKey(
    (step as any)?.expected_type
  );
  const validationMode = normalizeKey(
    (step as any)?.validation_mode
  );

  return (
    stepKey === "confirm" ||
    stepKey === "confirmation" ||
    stepKey === "offer_booking_sms" ||
    slot === "confirmation" ||
    expectedType === "confirmation" ||
    validationMode === "confirmation"
  );
}

function hasCollectedStepValue(params: {
  step: BookingFlowStepLike;
  answersBySlot: Record<string, unknown>;
}): boolean {
  if (isExplicitInteractionStep(params.step)) {
    return false;
  }

  const stepKey = clean((params.step as any)?.step_key);
  const slot =
    clean((params.step as any)?.slot) || stepKey;

  if (!stepKey && !slot) {
    return false;
  }

  const slotValue = slot
    ? clean(params.answersBySlot[slot])
    : "";

  const stepKeyValue = stepKey
    ? clean(params.answersBySlot[stepKey])
    : "";

  return Boolean(slotValue || stepKeyValue);
}

function resolveNextUnansweredStepIndex(params: {
  steps: BookingFlowStepLike[];
  currentIndex: number;
  answersBySlot: Record<string, unknown>;
}): number | null {
  const firstCandidateIndex = params.currentIndex + 1;

  for (
    let index = firstCandidateIndex;
    index < params.steps.length;
    index += 1
  ) {
    const step = params.steps[index];

    const alreadyAnswered = hasCollectedStepValue({
      step,
      answersBySlot: params.answersBySlot,
    });

    if (!alreadyAnswered) {
      return index;
    }
  }

  return null;
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
    bookingContextState,
    buildRealtimeBookingState,
    persistVoiceState,
  } = params;

  /**
   * Preserve values that existed when the booking tool was invoked,
   * including trusted data supplied by the returning-customer module.
   *
   * Values produced by the current step take precedence.
   */
  const mergedBookingData = {
    ...(isRecord(bookingContextState.bookingData)
      ? bookingContextState.bookingData
      : {}),
    ...(isRecord(workingState.bookingData)
      ? workingState.bookingData
      : {}),
  };

  const stateWithMergedBookingData: CallState = {
    ...bookingContextState,
    ...workingState,
    bookingData: mergedBookingData,
  };

  /**
   * Do not use callerPhone as an automatic answer here.
   *
   * New callers may still need to confirm or replace their inbound
   * number. Only values explicitly present in bookingData may cause
   * a future step to be skipped.
   */
  const collectedAnswers =
    normalizeAnswersToCanonicalSlots({
      steps,
      answersBySlot: buildAnswersBySlot({
        args: {},
        callerPhone: null,
        state: stateWithMergedBookingData,
      }),
    });

  const nextIndex = resolveNextUnansweredStepIndex({
    steps,
    currentIndex,
    answersBySlot: collectedAnswers,
  });

  const advancedState: CallState = {
    ...stateWithMergedBookingData,
    bookingStepIndex:
      typeof nextIndex === "number"
        ? nextIndex
        : undefined,
  };

  const skippedSteps =
    typeof nextIndex === "number"
      ? steps.slice(currentIndex + 1, nextIndex)
      : steps.slice(currentIndex + 1);

  if (skippedSteps.length > 0) {
    console.log(
      "[VOICE_REALTIME][BOOKING_PREFILLED_STEPS_SKIPPED]",
      {
        callSid,
        currentIndex,
        nextIndex,
        skippedSteps: skippedSteps.map((step) => ({
          stepKey: clean((step as any)?.step_key),
          slot: clean((step as any)?.slot),
        })),
      }
    );
  }

  const isFlowComplete = nextIndex === null;

  const finalConfirmationGranted = Boolean(
    clean(advancedState.bookingData?.confirmation) ||
      clean(
        advancedState.bookingData?.customer_confirmed
      )
  );

  const bookingState = isFlowComplete
    ? {
        current_step_key: null,
        current_step_slot: null,
        awaiting_confirmation: false,
        final_confirmation_granted:
          finalConfirmationGranted,
        ready_to_create: finalConfirmationGranted,
        collected_slots:
          normalizeAnswersToCanonicalSlots({
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
      step_key:
        nextRequiredStepResult.step_key,
      slot:
        nextRequiredStepResult.slot,
      prompt_error: String(
        nextRequiredStepResult.prompt_error
      ),
      retry_prompt_error: String(
        nextRequiredStepResult.retry_prompt_error
      ),
    };
  }

  await persistVoiceState({
    tenantId,
    callSid,
    state: advancedState,
    locale: currentLocale,
  });

  const nextRequiredStep =
    nextRequiredStepResult.next_required_step;

  const nextStepKey = clean(
    nextRequiredStep?.step_key || ""
  );

  return {
    ok: true,
    advancedState,
    booking_state: bookingState,
    next_required_step: nextRequiredStep,
    assistant_prompt:
      nextStepKey === "confirm"
        ? clean(nextRequiredStep?.prompt || "")
        : "",
    action_required: isFlowComplete
      ? finalConfirmationGranted
        ? "create_appointment"
        : null
      : nextStepKey === "confirm"
        ? "awaiting_confirmation"
        : null,
  };
}