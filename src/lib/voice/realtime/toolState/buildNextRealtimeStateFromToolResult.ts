// src/lib/voice/realtime/toolState/buildNextRealtimeStateFromToolResult.ts
import type { CallState } from "../../types";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

type BuildNextRealtimeStateFromToolResultParams = {
  realtimeState: CallState;
  toolName: string;
  toolResult: any;
  effectiveToolArgs: Record<string, any>;
  currentLocale: string;
  lastUserTranscript: string;
};

export function buildNextRealtimeStateFromToolResult(
  params: BuildNextRealtimeStateFromToolResultParams
): CallState {
  const {
    realtimeState,
    toolName,
    toolResult,
    effectiveToolArgs,
    currentLocale,
    lastUserTranscript,
  } = params;

  const stateAny = realtimeState as any;

  const normalizedLastUserTranscript = clean(
    lastUserTranscript ||
      stateAny.lastUserTranscript ||
      stateAny.currentTranscript ||
      stateAny.lastTranscript ||
      ""
  );

  const effectiveCurrentTranscriptSeq =
    typeof realtimeState.lastUserTranscriptSeq === "number"
      ? realtimeState.lastUserTranscriptSeq
      : 0;

  const bookingState =
    toolResult &&
    typeof toolResult.booking_state === "object" &&
    toolResult.booking_state !== null
      ? (toolResult.booking_state as Record<string, unknown>)
      : null;

  const collectedSlots =
    bookingState &&
    bookingState.collected_slots &&
    typeof bookingState.collected_slots === "object"
      ? Object.fromEntries(
          Object.entries(bookingState.collected_slots as Record<string, unknown>)
            .map(([key, value]) => [clean(key), clean(value)])
            .filter(([key, value]) => key && value)
        )
      : {};

  const nextRequiredStep =
    toolResult &&
    typeof toolResult.next_required_step === "object" &&
    toolResult.next_required_step !== null
      ? (toolResult.next_required_step as Record<string, unknown>)
      : null;

  const resolvedPendingBookingStepKey =
    clean(nextRequiredStep?.step_key || "") || undefined;

  const resolvedPendingBookingStepSlot = clean(nextRequiredStep?.slot || "");

  const resolvedPendingBookingStepExpectedType = clean(
    nextRequiredStep?.expected_type || ""
  );

  const resolvedPendingBookingStepRequired =
    nextRequiredStep?.required === true;

  const nextStepExpectsUserInput =
    Boolean(resolvedPendingBookingStepKey) &&
    (resolvedPendingBookingStepRequired ||
      resolvedPendingBookingStepExpectedType === "confirmation" ||
      resolvedPendingBookingStepExpectedType === "phone" ||
      resolvedPendingBookingStepExpectedType === "datetime" ||
      resolvedPendingBookingStepExpectedType === "number" ||
      resolvedPendingBookingStepExpectedType === "staff" ||
      (resolvedPendingBookingStepExpectedType === "text" &&
        resolvedPendingBookingStepSlot !== "none"));

  const shouldClearPendingBookingStep =
    toolName === "send_booking_sms" ||
    toolName === "end_call" ||
    !nextStepExpectsUserInput;

  const submittedBookingStepKey =
    toolName === "submit_booking_step"
      ? clean(effectiveToolArgs.step_key || "")
      : "";

  const hasSubmittedPendingBookingStep =
    Boolean(submittedBookingStepKey) &&
    submittedBookingStepKey === clean(realtimeState.pendingBookingStepKey || "");

  const actionRequiredToolName = clean(toolResult?.action_required || "");

  const pendingActionGranted =
    hasSubmittedPendingBookingStep &&
    toolResult?.ok === true &&
    Boolean(actionRequiredToolName);

  const shouldClearPendingAction =
    toolName === "create_appointment" ||
    toolName === "send_booking_sms" ||
    toolName === "end_call";

  return {
    ...realtimeState,
    lang: currentLocale as any,

    lastUserTranscript: normalizedLastUserTranscript,
    lastUserTranscriptSeq: effectiveCurrentTranscriptSeq,

    bookingData: {
      ...(realtimeState.bookingData || {}),
      ...collectedSlots,
    },

    pendingBookingStepKey: shouldClearPendingBookingStep
      ? undefined
      : resolvedPendingBookingStepKey,

    pendingBookingStepRequired:
      shouldClearPendingBookingStep || !resolvedPendingBookingStepKey
        ? undefined
        : nextRequiredStep?.required === true,

    pendingBookingStepSlot:
      shouldClearPendingBookingStep || !resolvedPendingBookingStepKey
        ? undefined
        : resolvedPendingBookingStepSlot,

    pendingBookingStepExpectedType:
      shouldClearPendingBookingStep || !resolvedPendingBookingStepKey
        ? undefined
        : resolvedPendingBookingStepExpectedType,

    pendingBookingStepPrompt:
      shouldClearPendingBookingStep || !resolvedPendingBookingStepKey
        ? undefined
        : clean(nextRequiredStep?.prompt || "") || undefined,

    pendingBookingStepPromptAnchorTranscript:
      shouldClearPendingBookingStep || !resolvedPendingBookingStepKey
        ? undefined
        : normalizedLastUserTranscript,

    pendingBookingStepPromptAnchorSeq:
      shouldClearPendingBookingStep || !resolvedPendingBookingStepKey
        ? undefined
        : effectiveCurrentTranscriptSeq,

    pendingBookingStepAwaitingFreshUserInput:
      shouldClearPendingBookingStep || !resolvedPendingBookingStepKey
        ? undefined
        : true,

    pendingBookingStepRequiresFreshInputAfterPrompt:
      shouldClearPendingBookingStep || !resolvedPendingBookingStepKey
        ? undefined
        : true,

    lastSubmittedBookingStepKey:
      toolName === "submit_booking_step"
        ? clean(effectiveToolArgs.step_key || "")
        : realtimeState.lastSubmittedBookingStepKey,

    lastSubmittedBookingTranscript:
      toolName === "submit_booking_step"
        ? normalizedLastUserTranscript || clean(effectiveToolArgs.value || "")
        : realtimeState.lastSubmittedBookingTranscript,

    lastSubmittedBookingTranscriptSeq:
      toolName === "submit_booking_step"
        ? effectiveCurrentTranscriptSeq
        : realtimeState.lastSubmittedBookingTranscriptSeq,

    pendingActionGranted:
      shouldClearPendingAction
        ? undefined
        : pendingActionGranted
          ? true
          : realtimeState.pendingActionGranted,

    pendingActionAnswered:
      shouldClearPendingAction
        ? undefined
        : hasSubmittedPendingBookingStep &&
            toolResult?.ok === true &&
            Boolean(actionRequiredToolName)
          ? true
          : realtimeState.pendingActionAnswered,

    pendingActionToolName:
      shouldClearPendingAction
        ? undefined
        : pendingActionGranted
          ? actionRequiredToolName
          : realtimeState.pendingActionToolName,

    awaitingPostBookingClosure:
      (toolName === "create_appointment" || toolName === "send_booking_sms") &&
      toolResult?.ok === true
        ? true
        : toolName === "end_call"
          ? undefined
          : (realtimeState as any)?.awaitingPostBookingClosure,

    postBookingClosureTranscript:
      (toolName === "create_appointment" || toolName === "send_booking_sms") &&
      toolResult?.ok === true
        ? normalizedLastUserTranscript
        : toolName === "end_call"
          ? undefined
          : (realtimeState as any)?.postBookingClosureTranscript,

    postBookingClosureTranscriptSeq:
      (toolName === "create_appointment" || toolName === "send_booking_sms") &&
      toolResult?.ok === true
        ? effectiveCurrentTranscriptSeq
        : toolName === "end_call"
          ? undefined
          : (realtimeState as any)?.postBookingClosureTranscriptSeq,
  } as CallState;
}