// src/lib/appointments/booking/runtime/startSharedBookingFlow.ts

import type {
  CallState,
  VoiceLocale,
} from "../../../voice/types";

import {
  getSharedBookingFlow,
} from "../../getBookingFlow";

import {
  buildAnswersBySlot,
  buildCanonicalCallState,
  clean,
  extractStringRecord,
  getStepSlot,
  isConfirmationLikeStep,
  normalizeAnswersToCanonicalSlots,
  resolveCurrentStepIndex,
  sortFlowSteps,
  type BookingFlowStepLike,
  type BookingState,
} from "../../../voice/realtime/realtimeBookingFlowUtils";

import {
  buildRealtimeNextRequiredStep,
  type RealtimeMappedStep,
} from "../../../voice/realtime/bookingStep/buildRealtimeNextRequiredStep";

export type StartSharedBookingFlowParams = {
  tenantId: string;
  locale: VoiceLocale;
  contactPhone: string | null;
  state?: CallState | null;
};

export type StartSharedBookingFlowResult =
  | {
      ok: true;
      state: CallState;
      booking_state: BookingState;
      next_required_step: RealtimeMappedStep | null;
      assistant_prompt: string;
      flow_complete: boolean;
    }
  | {
      ok: false;
      error:
        | "BOOKING_FLOW_NOT_CONFIGURED"
        | "BOOKING_FLOW_CONFIGURATION_INVALID";
      state: CallState;
      booking_state: BookingState | null;
      next_required_step: null;
      assistant_prompt: string;
      details?: Record<string, unknown>;
    };

function buildSharedBookingState(params: {
  steps: BookingFlowStepLike[];
  state: CallState;
  explicitCurrentIndex?: number | null;
}): BookingState {
  const answersBySlot =
    normalizeAnswersToCanonicalSlots({
      steps: params.steps,
      answersBySlot: extractStringRecord(
        params.state.bookingData
      ),
    });

  const currentIndex =
    typeof params.explicitCurrentIndex === "number"
      ? params.explicitCurrentIndex
      : resolveCurrentStepIndex({
          steps: params.steps,
          state: params.state,
          answersBySlot,
        });

  const currentStep =
    typeof currentIndex === "number" &&
    currentIndex >= 0 &&
    currentIndex < params.steps.length
      ? params.steps[currentIndex]
      : null;

  return {
    current_step_key: currentStep
      ? clean(currentStep.step_key) || null
      : null,

    current_step_slot: currentStep
      ? getStepSlot(currentStep) || null
      : null,

    awaiting_confirmation: currentStep
      ? isConfirmationLikeStep(currentStep)
      : false,

    final_confirmation_granted: Boolean(
      clean(
        params.state.bookingData?.confirmation ||
          params.state.bookingData?.customer_confirmed
      )
    ),

    ready_to_create: false,

    collected_slots: answersBySlot,
  };
}

function buildPendingStepState(params: {
  state: CallState;
  currentIndex: number | null;
  nextStep: RealtimeMappedStep | null;
}): CallState {
  const { state, currentIndex, nextStep } = params;

  if (!nextStep) {
    return {
      ...state,

      bookingStepIndex: undefined,

      pendingBookingStepKey: undefined,
      pendingBookingStepPrompt: undefined,
      pendingBookingStepRequired: undefined,
      pendingBookingStepSlot: undefined,
      pendingBookingStepExpectedType: undefined,
      pendingBookingStepValidationConfig: undefined,

      bookingTurnStatus: "flow_complete",
    };
  }

  return {
    ...state,

    bookingStepIndex:
      typeof currentIndex === "number"
        ? currentIndex
        : undefined,

    pendingBookingStepKey: nextStep.step_key,
    pendingBookingStepPrompt: nextStep.prompt,
    pendingBookingStepRequired: nextStep.required,
    pendingBookingStepSlot: nextStep.slot,
    pendingBookingStepExpectedType:
      nextStep.expected_type,
    pendingBookingStepValidationConfig:
      nextStep.validation_config || {},

    bookingTurnStatus: "waiting_user_answer",
  };
}

export async function startSharedBookingFlow(
  params: StartSharedBookingFlowParams
): Promise<StartSharedBookingFlowResult> {
  const tenantId = clean(params.tenantId);

  if (!tenantId) {
    throw new Error(
      "START_SHARED_BOOKING_FLOW_TENANT_REQUIRED"
    );
  }

  const steps = sortFlowSteps(
    (await getSharedBookingFlow(
      tenantId
    )) as BookingFlowStepLike[]
  );

  const baseState: CallState = {
    ...(params.state || ({} as CallState)),
    bookingData: {
      ...((params.state as CallState | null)
        ?.bookingData || {}),
    },
  };

  if (steps.length === 0) {
    return {
      ok: false,
      error: "BOOKING_FLOW_NOT_CONFIGURED",
      state: baseState,
      booking_state: null,
      next_required_step: null,
      assistant_prompt: "",
    };
  }

  const answersBySlot =
    normalizeAnswersToCanonicalSlots({
      steps,
      answersBySlot: buildAnswersBySlot({
        args: {},
        callerPhone: params.contactPhone,
        state: baseState,
      }),
    });

  const currentIndex = resolveCurrentStepIndex({
    steps,
    state: baseState,
    answersBySlot,
  });

  const canonicalState = buildCanonicalCallState({
    state: baseState,
    answersBySlot,
    bookingStepIndex: currentIndex,
  });

  const bookingState = buildSharedBookingState({
    steps,
    state: canonicalState,
    explicitCurrentIndex: currentIndex,
  });

  const nextStepResult =
    buildRealtimeNextRequiredStep({
      steps,
      bookingState,
      locale: params.locale,
    });

  if (!nextStepResult.ok) {
    return {
      ok: false,
      error:
        "BOOKING_FLOW_CONFIGURATION_INVALID",
      state: canonicalState,
      booking_state: bookingState,
      next_required_step: null,
      assistant_prompt: "",
      details: {
        step_key: nextStepResult.step_key,
        slot: nextStepResult.slot,
        prompt_error:
          nextStepResult.prompt_error,
        retry_prompt_error:
          nextStepResult.retry_prompt_error,
      },
    };
  }

  const nextRequiredStep =
    nextStepResult.next_required_step;

  const nextState = buildPendingStepState({
    state: canonicalState,
    currentIndex,
    nextStep: nextRequiredStep,
  });

  return {
    ok: true,
    state: nextState,
    booking_state: bookingState,
    next_required_step: nextRequiredStep,
    assistant_prompt: clean(
      nextRequiredStep?.prompt
    ),
    flow_complete: nextRequiredStep === null,
  };
}