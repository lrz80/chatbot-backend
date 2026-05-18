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
  buildNextRequiredStep: (params: {
    steps: BookingFlowStepLike[];
    bookingState: BookingState;
    locale?: VoiceLocale;
    overridePrompt?: string;
  }) => RealtimeMappedStep | null;
}): ResolveExpectedRealtimeBookingStepResult {
  const {
    stepKey,
    steps,
    state,
    callerPhone,
    currentLocale,
    buildRealtimeBookingState,
    buildNextRequiredStep,
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
        next_required_step: buildNextRequiredStep({
          steps,
          bookingState,
          locale: currentLocale,
        }),
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