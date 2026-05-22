// src/lib/voice/realtime/bookingStep/resolveExpectedRealtimeBookingStep.ts
import type { CallState, VoiceLocale } from "../../types";
import {
  clean,
  buildAnswersBySlot,
  normalizeAnswersToCanonicalSlots,
  getStepIndexByKey,
  resolveCurrentStepIndex,
  type BookingFlowStepLike,
  type BookingState,
} from "../realtimeBookingFlowUtils";
import {
  buildRealtimeNextRequiredStep,
  type RealtimeMappedStep,
} from "./buildRealtimeNextRequiredStep";

export type ResolveExpectedRealtimeBookingStepResult =
  | {
      ok: true;
      currentIndex: number;
      currentStep: BookingFlowStepLike;
      persistedAnswers: Record<string, string>;
    }
  | {
      ok: false;
      result: any;
    };

function buildTemplateInvalidResult(params: {
  bookingState: BookingState;
  nextStepResult: Extract<
    ReturnType<typeof buildRealtimeNextRequiredStep>,
    { ok: false }
  >;
}) {
  const { bookingState, nextStepResult } = params;

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

function resolveNextRequiredStepOrError(params: {
  steps: BookingFlowStepLike[];
  bookingState: BookingState;
  locale: VoiceLocale;
}):
  | {
      ok: true;
      next_required_step: RealtimeMappedStep | null;
    }
  | {
      ok: false;
      result: any;
    } {
  const nextStepResult = buildRealtimeNextRequiredStep({
    steps: params.steps,
    bookingState: params.bookingState,
    locale: params.locale,
  });

  if (!nextStepResult.ok) {
    return {
      ok: false,
      result: buildTemplateInvalidResult({
        bookingState: params.bookingState,
        nextStepResult,
      }),
    };
  }

  return {
    ok: true,
    next_required_step: nextStepResult.next_required_step,
  };
}

export function resolveExpectedRealtimeBookingStep(params: {
  stepKey: string;
  steps: BookingFlowStepLike[];
  state: CallState;
  callerPhone: string | null;
  currentLocale: VoiceLocale;
  buildRealtimeBookingState: (params: {
    steps: BookingFlowStepLike[];
    state: CallState;
    explicitCurrentIndex?: number | null;
    finalConfirmationGranted?: boolean;
    readyToCreate?: boolean;
  }) => BookingState;
}): ResolveExpectedRealtimeBookingStepResult {
  const {
    stepKey,
    steps,
    state,
    callerPhone,
    currentLocale,
    buildRealtimeBookingState,
  } = params;

  const providedIndex = getStepIndexByKey(steps, stepKey);

  if (providedIndex === -1) {
    return {
      ok: false,
      result: {
        ok: false,
        error: "UNKNOWN_BOOKING_STEP",
        message: `Unknown booking step: ${stepKey}`,
      },
    };
  }

  const persistedAnswers = normalizeAnswersToCanonicalSlots({
    steps,
    answersBySlot: buildAnswersBySlot({
      args: {},
      callerPhone,
      state,
    }),
  });

  const pendingStepKey = clean(state.pendingBookingStepKey || "");
  const pendingStepIndex = pendingStepKey
    ? getStepIndexByKey(steps, pendingStepKey)
    : -1;

  const submittedMatchesPendingStep =
    pendingStepIndex >= 0 && stepKey === pendingStepKey;

  const expectedIndex = submittedMatchesPendingStep
    ? pendingStepIndex
    : typeof state.bookingStepIndex === "number" &&
        state.bookingStepIndex >= 0 &&
        state.bookingStepIndex < steps.length
      ? state.bookingStepIndex
      : resolveCurrentStepIndex({
          steps,
          state,
          answersBySlot: persistedAnswers,
        });

  if (typeof expectedIndex !== "number" || expectedIndex < 0) {
    const bookingState = buildRealtimeBookingState({
      steps,
      state,
      explicitCurrentIndex: null,
    });

    return {
      ok: false,
      result: {
        ok: false,
        error: "BOOKING_FLOW_NOT_LOADED",
        message: "Booking flow state is not ready for this realtime call.",
        booking_state: bookingState,
        next_required_step: null,
      },
    };
  }

  if (providedIndex !== expectedIndex) {
    const expectedStep = steps[expectedIndex];

    const bookingState = buildRealtimeBookingState({
      steps,
      state,
      explicitCurrentIndex: expectedIndex,
    });

    const nextRequiredStepResult = resolveNextRequiredStepOrError({
      steps,
      bookingState,
      locale: currentLocale,
    });

    if (!nextRequiredStepResult.ok) {
      return {
        ok: false,
        result: nextRequiredStepResult.result,
      };
    }

    return {
      ok: false,
      result: {
        ok: false,
        error: "BOOKING_STEP_MISMATCH",
        message: `Received step ${stepKey}, but expected ${clean(
          expectedStep?.step_key
        )}.`,
        expected_step_key: clean(expectedStep?.step_key),
        received_step_key: stepKey,
        booking_state: bookingState,
        next_required_step: nextRequiredStepResult.next_required_step,
      },
    };
  }

  return {
    ok: true,
    currentIndex: expectedIndex,
    currentStep: steps[expectedIndex],
    persistedAnswers,
  };
}