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
  buildNextRequiredStep: (params: {
    steps: BookingFlowStepLike[];
    bookingState: BookingState;
    locale?: VoiceLocale;
    overridePrompt?: string;
  }) => RealtimeMappedStep | null;
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
    buildNextRequiredStep,
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
      assistant_prompt: [
        "Use only the tool result as source of truth.",
        "The staff preference could not be resolved to one clear bookable staff member.",
        "Ask the caller to choose from the available staff candidates if candidates are present.",
        "If no candidates are present, ask the configured staff question again naturally.",
        "Do not invent staff names.",
      ].join(" "),
      booking_state: bookingState,
      next_required_step: buildNextRequiredStep({
        steps,
        bookingState,
        locale: currentLocale,
        overridePrompt: clean(currentStep.retry_prompt || currentStep.prompt),
      }),
    },
  };
}