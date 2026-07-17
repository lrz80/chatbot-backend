// src/lib/appointments/booking/runtime/submitSharedBookingStep.ts

import type {
  CallState,
  VoiceLocale,
} from "../../../voice/types";

import {
  getSharedBookingFlow,
} from "../../getBookingFlow";

import {
  buildAnswersBySlot,
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

import {
  prepareRealtimeStepSubmission,
} from "../../../voice/realtime/bookingStep/prepareRealtimeStepSubmission";

import {
  executeRealtimeStepRoute,
} from "../../../voice/realtime/bookingStep/executeRealtimeStepRoute";

import {
  advanceRealtimeBookingStep,
} from "../../../voice/realtime/bookingStep/advanceRealtimeBookingStep";

import {
  resolveGlobalConfirmationIntent,
} from "../../../voice/realtime/bookingStep/resolveGlobalConfirmationIntent";

export type SubmitSharedBookingStepParams = {
  tenantId: string;

  /**
   * Identificador estable de la conversación:
   * whatsapp:+1...
   * facebook:PSID
   * instagram:IGSID
   */
  sessionId: string;

  locale: VoiceLocale;
  contactPhone: string | null;

  /**
   * Texto humano recibido por WhatsApp/Meta.
   */
  userInput: string;

  /**
   * Estado recuperado de context.booking_runtime.state.
   */
  state: CallState;

  /**
   * Contexto del tenant usado por los mismos handlers de Voice.
   */
  tenant?: any;
  cfg?: any;

  /**
   * Persiste únicamente el estado del runtime.
   * El adaptador exterior decidirá cómo guardarlo en conversation_state.
   */
  persistState: (state: CallState) => Promise<void>;
};

export type SubmitSharedBookingStepResult =
  | {
      ok: true;
      state: CallState;
      booking_state: BookingState;
      next_required_step: RealtimeMappedStep | null;
      assistant_prompt: string;
      action_required:
        | "awaiting_confirmation"
        | "create_appointment"
        | null;
      flow_complete: boolean;
    }
  | {
      ok: false;
      error: string;
      state: CallState;
      booking_state: BookingState | null;
      next_required_step: RealtimeMappedStep | null;
      assistant_prompt: string;
      retryable: boolean;
      details?: Record<string, unknown>;
    };

function buildSharedBookingState(params: {
  steps: BookingFlowStepLike[];
  state: CallState;
  explicitCurrentIndex?: number | null;
  finalConfirmationGranted?: boolean;
  readyToCreate?: boolean;
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

  const confirmationStored = Boolean(
    clean(
      params.state.bookingData?.confirmation ||
        params.state.bookingData
          ?.customer_confirmed
    )
  );

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

    final_confirmation_granted:
      params.finalConfirmationGranted ??
      confirmationStored,

    ready_to_create:
      params.readyToCreate ?? false,

    collected_slots: answersBySlot,
  };
}

function getCurrentPendingStep(params: {
  steps: BookingFlowStepLike[];
  state: CallState;
}): {
  currentIndex: number;
  currentStep: BookingFlowStepLike;
} | null {
  const pendingStepKey = clean(
    params.state.pendingBookingStepKey
  );

  if (pendingStepKey) {
    const pendingIndex =
      params.steps.findIndex(
        (step) =>
          clean(step.step_key) ===
          pendingStepKey
      );

    if (pendingIndex >= 0) {
      return {
        currentIndex: pendingIndex,
        currentStep:
          params.steps[pendingIndex],
      };
    }
  }

  if (
    typeof params.state.bookingStepIndex ===
      "number" &&
    params.state.bookingStepIndex >= 0 &&
    params.state.bookingStepIndex <
      params.steps.length
  ) {
    return {
      currentIndex:
        params.state.bookingStepIndex,
      currentStep:
        params.steps[
          params.state.bookingStepIndex
        ],
    };
  }

  const answersBySlot =
    normalizeAnswersToCanonicalSlots({
      steps: params.steps,
      answersBySlot: buildAnswersBySlot({
        args: {},
        callerPhone: null,
        state: params.state,
      }),
    });

  const resolvedIndex =
    resolveCurrentStepIndex({
      steps: params.steps,
      state: params.state,
      answersBySlot,
    });

  if (
    typeof resolvedIndex !== "number" ||
    resolvedIndex < 0 ||
    resolvedIndex >= params.steps.length
  ) {
    return null;
  }

  return {
    currentIndex: resolvedIndex,
    currentStep:
      params.steps[resolvedIndex],
  };
}

function applyPendingStepToState(params: {
  state: CallState;
  nextRequiredStep:
    | RealtimeMappedStep
    | null;
}): CallState {
  const { state, nextRequiredStep } =
    params;

  if (!nextRequiredStep) {
    return {
      ...state,

      bookingStepIndex: undefined,

      pendingBookingStepKey: undefined,
      pendingBookingStepPrompt: undefined,
      pendingBookingStepRequired:
        undefined,

      pendingBookingStepSlot: undefined,
      pendingBookingStepExpectedType:
        undefined,
      pendingBookingStepValidationConfig:
        undefined,

      bookingTurnStatus: "flow_complete",
    };
  }

  return {
    ...state,

    pendingBookingStepKey:
      nextRequiredStep.step_key,

    pendingBookingStepPrompt:
      nextRequiredStep.prompt,

    pendingBookingStepRequired:
      nextRequiredStep.required,

    pendingBookingStepSlot:
      nextRequiredStep.slot,

    pendingBookingStepExpectedType:
      nextRequiredStep.expected_type,

    pendingBookingStepValidationConfig:
      nextRequiredStep.validation_config,

    bookingTurnStatus:
      "waiting_user_answer",
  };
}

async function resolveSubmissionValue(params: {
  currentStep: BookingFlowStepLike;
  userInput: string;
  locale: VoiceLocale;
}): Promise<string> {
  const expectedType = clean(
    params.currentStep.expected_type
  ).toLowerCase();

  const targetSlot = clean(
    params.currentStep.validation_config
      ?.slot
  ).toLowerCase();

  const isConfirmation =
    expectedType === "confirmation" ||
    targetSlot === "confirmation" ||
    isConfirmationLikeStep(
      params.currentStep
    );

  if (!isConfirmation) {
    return params.userInput;
  }

  const confirmationIntent =
    await resolveGlobalConfirmationIntent({
      locale: params.locale,
      values: [params.userInput],
    });

  return (
    clean(confirmationIntent) ||
    "unknown"
  );
}

export async function submitSharedBookingStep(
  params: SubmitSharedBookingStepParams
): Promise<SubmitSharedBookingStepResult> {
  const tenantId = clean(params.tenantId);
  const sessionId = clean(params.sessionId);
  const userInput = clean(params.userInput);

  if (!tenantId) {
    throw new Error(
      "SUBMIT_SHARED_BOOKING_STEP_TENANT_REQUIRED"
    );
  }

  if (!sessionId) {
    throw new Error(
      "SUBMIT_SHARED_BOOKING_STEP_SESSION_REQUIRED"
    );
  }

  const steps = sortFlowSteps(
    (await getSharedBookingFlow(
      tenantId
    )) as BookingFlowStepLike[]
  );

  if (steps.length === 0) {
    return {
      ok: false,
      error:
        "BOOKING_FLOW_NOT_CONFIGURED",
      state: params.state,
      booking_state: null,
      next_required_step: null,
      assistant_prompt: "",
      retryable: false,
    };
  }

  const pending = getCurrentPendingStep({
    steps,
    state: params.state,
  });

  if (!pending) {
    return {
      ok: false,
      error:
        "BOOKING_PENDING_STEP_NOT_FOUND",
      state: params.state,
      booking_state: null,
      next_required_step: null,
      assistant_prompt: "",
      retryable: false,
    };
  }

  const submissionValue =
    await resolveSubmissionValue({
      currentStep: pending.currentStep,
      userInput,
      locale: params.locale,
    });

  const prepared =
    prepareRealtimeStepSubmission({
      callerPhone: params.contactPhone,

      args: {
        step_key: clean(
          pending.currentStep.step_key
        ),

        value: submissionValue,

        model_value: submissionValue,

        transcript_value: userInput,
        raw_transcript_value: userInput,

        resolved_candidate_source:
          "transcript",
      },

      bookingContext: {
        tenant:
          params.tenant || {
            id: tenantId,
          },

        cfg: params.cfg || {},

        callSid: sessionId,

        currentLocale: params.locale,

        state: params.state,

        userInput,
      },

      steps,

      buildRealtimeBookingState:
        buildSharedBookingState,
    });

  if (!prepared.ok) {
    const result =
      prepared.result || {};

    const nextRequiredStep =
      result.next_required_step || null;

    return {
      ok: false,
      error:
        clean(result.error) ||
        "BOOKING_STEP_PREPARATION_FAILED",

      state: params.state,

      booking_state:
        result.booking_state || null,

      next_required_step:
        nextRequiredStep,

      assistant_prompt:
        clean(
          nextRequiredStep?.retry_prompt ||
            nextRequiredStep?.prompt
        ),

      retryable: true,

      details: result,
    };
  }

  const routeResult =
    await executeRealtimeStepRoute({
      tenantId,
      callerPhone: params.contactPhone,

      bookingContext: {
        tenant:
          params.tenant || {
            id: tenantId,
          },

        cfg: params.cfg || {},

        callSid: sessionId,

        /**
         * Para mensajería no es un DID real.
         * Solo satisface el contrato actual mientras
         * neutralizamos los handlers.
         */
        didNumber:
          params.contactPhone || sessionId,

        currentLocale: params.locale,

        state: params.state,

        userInput,

        digits: "",
      },

      steps,

      currentStep:
        prepared.currentStep,

      currentIndex:
        prepared.currentIndex,

      targetSlot:
        prepared.targetSlot,

      stepKey: prepared.stepKey,

      resolvedInputValue:
        prepared.resolvedInputValue,

      rawTranscriptValue:
        prepared.rawTranscriptValue,

      modelValue:
        prepared.modelValue,

      sanitizedArgs:
        prepared.sanitizedArgs,

      buildRealtimeBookingState:
        buildSharedBookingState,

      persistVoiceState: async ({
        state,
      }) => {
        await params.persistState(state);
      },
    });

  if (routeResult.kind === "return") {
    const result =
      routeResult.result || {};

    const returnedState =
      result.advancedState ||
      result.state ||
      params.state;

    const nextRequiredStep =
      result.next_required_step || null;

    const nextState =
      applyPendingStepToState({
        state: returnedState,
        nextRequiredStep,
      });

    await params.persistState(nextState);

    return {
      ok: result.ok !== false,

      error:
        result.ok === false
          ? clean(result.error) ||
            "BOOKING_STEP_FAILED"
          : "",

      state: nextState,

      booking_state:
        result.booking_state ||
        buildSharedBookingState({
          steps,
          state: nextState,
        }),

      next_required_step:
        nextRequiredStep,

      assistant_prompt:
        clean(
          result.assistant_prompt ||
            nextRequiredStep?.retry_prompt ||
            nextRequiredStep?.prompt ||
            result.message
        ),

      action_required:
        result.action_required || null,

      flow_complete:
        nextRequiredStep === null,

      retryable:
        result.ok === false,

      details: result,
    } as SubmitSharedBookingStepResult;
  }

  const advanceResult =
    await advanceRealtimeBookingStep({
      tenantId,

      callerPhone:
        params.contactPhone,

      callSid: sessionId,

      currentLocale:
        params.locale,

      steps,

      currentIndex:
        prepared.currentIndex,

      workingState:
        routeResult.workingState,

      bookingContextState:
        params.state,

      buildRealtimeBookingState:
        buildSharedBookingState,

      persistVoiceState: async ({
        state,
      }) => {
        await params.persistState(state);
      },
    });

  if (!advanceResult.ok) {
    return {
      ok: false,

      error: advanceResult.error,

      state:
        advanceResult.advancedState,

      booking_state:
        advanceResult.booking_state,

      next_required_step: null,

      assistant_prompt: "",

      retryable: false,

      details: {
        step_key:
          advanceResult.step_key,

        slot:
          advanceResult.slot,

        prompt_error:
          advanceResult.prompt_error,

        retry_prompt_error:
          advanceResult.retry_prompt_error,
      },
    };
  }

  const nextState =
    applyPendingStepToState({
      state:
        advanceResult.advancedState,

      nextRequiredStep:
        advanceResult.next_required_step,
    });

  await params.persistState(nextState);

  return {
    ok: true,

    state: nextState,

    booking_state:
      advanceResult.booking_state,

    next_required_step:
      advanceResult.next_required_step,

    assistant_prompt:
      clean(
        advanceResult.assistant_prompt ||
          advanceResult
            .next_required_step?.prompt
      ),

    action_required:
      advanceResult.action_required,

    flow_complete:
      advanceResult.next_required_step ===
      null,
  };
}