// src/lib/voice/realtime/bookingStep/handlers/handleStaffRealtimeStep.ts
import type { CallState, VoiceLocale } from "../../../types";
import {
  clean,
  buildCanonicalCallState,
  normalizeComparable,
  type BookingFlowStepLike,
  type BookingState,
} from "../../realtimeBookingFlowUtils";
import { resolveSquareStaffMemberForTenant } from "../../../../integrations/square/resolveSquareStaffMemberForTenant";
import { buildRealtimeNextRequiredStep } from "../buildRealtimeNextRequiredStep";

export type HandleStaffRealtimeStepResult =
  | {
      kind: "return";
      result: any;
    }
  | {
      kind: "continue";
      workingState: CallState;
    };

function getValidationConfig(
  step: BookingFlowStepLike
): Record<string, unknown> {
  return step.validation_config && typeof step.validation_config === "object"
    ? (step.validation_config as Record<string, unknown>)
    : {};
}

function buildUniqueStaffCandidates(values: unknown[]): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const rawValue of values) {
    const value = clean(rawValue);

    if (!value) {
      continue;
    }

    const comparable = normalizeComparable(value);

    if (!comparable || seen.has(comparable)) {
      continue;
    }

    seen.add(comparable);
    candidates.push(value);
  }

  return candidates;
}

export async function handleStaffRealtimeStep(params: {
  tenantId: string;
  currentStep: BookingFlowStepLike;
  currentIndex: number;
  currentLocale: VoiceLocale;
  targetSlot: string;
  stepKey: string;
  resolvedInputValue: string;
  rawTranscriptValue?: string;
  modelValue?: string;
  rawAnswers: Record<string, string>;
  workingState: CallState;
  steps: BookingFlowStepLike[];
  buildRealtimeBookingState: (params: {
    steps: BookingFlowStepLike[];
    state: CallState;
    explicitCurrentIndex?: number | null;
    finalConfirmationGranted?: boolean;
    readyToCreate?: boolean;
  }) => BookingState;
}): Promise<HandleStaffRealtimeStepResult> {
  const {
    tenantId,
    currentStep,
    currentIndex,
    currentLocale,
    targetSlot,
    stepKey,
    resolvedInputValue,
    rawTranscriptValue,
    modelValue,
    rawAnswers,
    workingState,
    steps,
    buildRealtimeBookingState,
  } = params;

  const validationConfig = getValidationConfig(currentStep);

  const staffInputCandidates = buildUniqueStaffCandidates([
    resolvedInputValue,
    rawTranscriptValue,
    modelValue,
  ]);

  let lastStaffResult: Awaited<
    ReturnType<typeof resolveSquareStaffMemberForTenant>
  > | null = null;

  for (const inputText of staffInputCandidates) {
    const staffResult = await resolveSquareStaffMemberForTenant({
      tenantId,
      inputText,
      validationConfig,
      locale: currentLocale,
    });

    lastStaffResult = staffResult;

    if (!staffResult.ok) {
      continue;
    }

    const nextAnswers =
      staffResult.preference === "any"
        ? {
            ...rawAnswers,
            [targetSlot]: "any_available",
            [stepKey]: "any_available",
            staff_member: "any_available",
            staff_member_preference: "any",
            staff_member_id: "",
            staff_member_name: "",
          }
        : {
            ...rawAnswers,
            [targetSlot]: staffResult.displayName,
            [stepKey]: staffResult.displayName,
            staff_member: staffResult.displayName,
            staff_member_preference: "specific",
            staff_member_id: staffResult.teamMemberId,
            staff_member_name: staffResult.displayName,
          };

    return {
      kind: "continue",
      workingState: buildCanonicalCallState({
        state: {
          ...workingState,
          bookingData: {
            ...(workingState.bookingData || {}),
            ...nextAnswers,
          },
        },
        answersBySlot: nextAnswers,
        bookingStepIndex: currentIndex,
      }),
    };
  }

  const bookingState = buildRealtimeBookingState({
    steps,
    state: workingState,
    explicitCurrentIndex: currentIndex,
  });

  const retryPrompt = clean(currentStep.retry_prompt || currentStep.prompt);

  const nextStepResult = buildRealtimeNextRequiredStep({
    steps,
    bookingState,
    locale: currentLocale,
    overridePrompt: retryPrompt,
  });

  if (!nextStepResult.ok) {
    return {
      kind: "return",
      result: {
        ok: false,
        error: nextStepResult.error,
        step_key: nextStepResult.step_key,
        slot: nextStepResult.slot,
        prompt_error: nextStepResult.prompt_error,
        retry_prompt_error: nextStepResult.retry_prompt_error,
        message: "BOOKING_FLOW_CONFIGURATION_INVALID",
        booking_state: bookingState,
        next_required_step: null,
      },
    };
  }

  const nextRequiredStep = nextStepResult.next_required_step
    ? {
        ...nextStepResult.next_required_step,
        prompt: retryPrompt,
        retry_prompt: retryPrompt,
      }
    : null;

  return {
    kind: "return",
    result: {
      ok: false,
      error:
        lastStaffResult && lastStaffResult.ok === false
          ? lastStaffResult.error
          : "SQUARE_STAFF_NOT_FOUND",
      staff_candidates:
        lastStaffResult && lastStaffResult.ok === false
          ? lastStaffResult.candidates || []
          : [],
      tried_staff_inputs: staffInputCandidates,
      message: retryPrompt,
      assistant_prompt: retryPrompt,
      booking_state: bookingState,
      next_required_step: nextRequiredStep,
    },
  };
}