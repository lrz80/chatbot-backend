// src/lib/voice/realtime/bookingStep/advanceRealtimeBookingStep.ts
import type { CallState, VoiceLocale } from "../../types";
import {
  clean,
  buildAnswersBySlot,
  normalizeAnswersToCanonicalSlots,
  type BookingFlowStepLike,
  type BookingState,
} from "../realtimeBookingFlowUtils";
import { buildRealtimeNextRequiredStep } from "./buildRealtimeNextRequiredStep";

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

export async function advanceRealtimeBookingStep(
  params: AdvanceRealtimeBookingStepParams
): Promise<{
  ok: true;
  advancedState: CallState;
  booking_state: BookingState;
  next_required_step: RealtimeMappedStep | null;
  assistant_prompt: string;
  action_required: "awaiting_confirmation" | null;
}> {
  const {
    tenantId,
    callerPhone,
    callSid,
    currentLocale,
    steps,
    currentIndex,
    workingState,
    buildRealtimeBookingState,
    buildNextRequiredStep,
    persistVoiceState,
  } = params;

  const nextIndex = currentIndex + 1 < steps.length ? currentIndex + 1 : null;

  const advancedState: CallState = {
    ...workingState,
    bookingStepIndex: typeof nextIndex === "number" ? nextIndex : undefined,
  };

  await persistVoiceState({
    tenantId,
    callSid,
    state: advancedState,
    locale: currentLocale,
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

  const nextRequiredStepResult = isFlowComplete
    ? { ok: true as const, next_required_step: null }
    : buildRealtimeNextRequiredStep({
        steps,
        bookingState,
        locale: currentLocale,
      });

  if (!nextRequiredStepResult.ok) {
    return {
      ok: true,
      advancedState,
      booking_state: bookingState,
      next_required_step: null,
      assistant_prompt: "",
      action_required: null,
      error: nextRequiredStepResult.error,
    } as any;
  }

  const nextRequiredStep = nextRequiredStepResult.next_required_step;

  const nextStepKey = clean(nextRequiredStep?.step_key || "");

  return {
    ok: true,
    advancedState,
    booking_state: bookingState,
    next_required_step: nextRequiredStep,
    assistant_prompt:
      nextStepKey === "confirm" ? clean(nextRequiredStep?.prompt || "") : "",
    action_required:
      nextStepKey === "confirm" ? "awaiting_confirmation" : null,
  };
}