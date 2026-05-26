// src/lib/voice/realtime/bookingRuntimeState.ts
import type { CallState } from "../types";
import {
  clearBookingTurnState,
  markBookingWaitingForAssistantPrompt,
} from "./bookingTurnState";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

function pickDefined<T>(
  primary: T | undefined,
  fallback: T | undefined
): T | undefined {
  return typeof primary !== "undefined" ? primary : fallback;
}

function pickNonEmptyString(
  primary: string | undefined,
  fallback: string | undefined
): string | undefined {
  const primaryClean = clean(primary);
  if (primaryClean) return primaryClean;

  const fallbackClean = clean(fallback);
  if (fallbackClean) return fallbackClean;

  return primary ?? fallback;
}

function hasBookingData(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length > 0
  );
}

function resolveConsumedBookingSubmitValue(params: {
  effectiveToolArgs: Record<string, any>;
  lastUserTranscript: string;
}): string {
  return clean(
    params.effectiveToolArgs?.resolved_value ||
      params.effectiveToolArgs?.submitted_value ||
      params.effectiveToolArgs?.value ||
      params.lastUserTranscript
  );
}

export function attachLatestUserTranscriptSeq(params: {
  realtimeState: CallState;
  lastUserTranscriptSeq: number;
}): CallState {
  return {
    ...params.realtimeState,
    lastUserTranscriptSeq: finiteNumber(params.lastUserTranscriptSeq, -1),
  };
}

export function mergeTranscriptStatePreservingBookingRuntime(params: {
  currentToolState: CallState;
  transcriptState: CallState;
  lastUserTranscriptSeq: number;
}): CallState {
  const { currentToolState, transcriptState, lastUserTranscriptSeq } = params;

  return {
    ...transcriptState,

    lastUserTranscriptSeq: finiteNumber(lastUserTranscriptSeq, -1),

    bookingStepIndex:
      typeof currentToolState.bookingStepIndex === "number"
        ? currentToolState.bookingStepIndex
        : transcriptState.bookingStepIndex,

    bookingData: hasBookingData(currentToolState.bookingData)
      ? currentToolState.bookingData
      : transcriptState.bookingData,

    bookingTurnStatus: pickDefined(
      (currentToolState as any).bookingTurnStatus,
      (transcriptState as any).bookingTurnStatus
    ),

    pendingBookingStepKey: pickNonEmptyString(
      currentToolState.pendingBookingStepKey,
      transcriptState.pendingBookingStepKey
    ),

    pendingBookingStepRequired: pickDefined(
      currentToolState.pendingBookingStepRequired,
      transcriptState.pendingBookingStepRequired
    ),

    pendingBookingStepPrompt: pickNonEmptyString(
      currentToolState.pendingBookingStepPrompt,
      transcriptState.pendingBookingStepPrompt
    ),

    pendingBookingStepPromptAnchorTranscript: pickDefined(
      currentToolState.pendingBookingStepPromptAnchorTranscript,
      transcriptState.pendingBookingStepPromptAnchorTranscript
    ),

    pendingBookingStepPromptAnchorSeq:
      typeof currentToolState.pendingBookingStepPromptAnchorSeq === "number"
        ? currentToolState.pendingBookingStepPromptAnchorSeq
        : transcriptState.pendingBookingStepPromptAnchorSeq,

    lastSubmittedBookingStepKey: pickDefined(
      currentToolState.lastSubmittedBookingStepKey,
      transcriptState.lastSubmittedBookingStepKey
    ),

    lastSubmittedBookingTranscript: pickDefined(
      currentToolState.lastSubmittedBookingTranscript,
      transcriptState.lastSubmittedBookingTranscript
    ),

    lastSubmittedBookingTranscriptSeq:
      typeof currentToolState.lastSubmittedBookingTranscriptSeq === "number"
        ? currentToolState.lastSubmittedBookingTranscriptSeq
        : transcriptState.lastSubmittedBookingTranscriptSeq,

    pendingActionGranted: pickDefined(
      currentToolState.pendingActionGranted,
      transcriptState.pendingActionGranted
    ),

    pendingActionAnswered: pickDefined(
      currentToolState.pendingActionAnswered,
      transcriptState.pendingActionAnswered
    ),

    pendingActionToolName: pickDefined(
      currentToolState.pendingActionToolName,
      transcriptState.pendingActionToolName
    ),

    awaitingPostBookingClosure: pickDefined(
      currentToolState.awaitingPostBookingClosure,
      transcriptState.awaitingPostBookingClosure
    ),

    postBookingClosureTranscript: pickDefined(
      currentToolState.postBookingClosureTranscript,
      transcriptState.postBookingClosureTranscript
    ),
  } as CallState;
}

/**
 * Legacy helper kept temporarily because other runtime files may still import it.
 * The new source of truth is bookingTurnState.ts.
 */
export function clearPendingBookingStepAnchor(realtimeState: CallState): CallState {
  return clearBookingTurnState(realtimeState);
}

/**
 * Legacy helper kept temporarily because other runtime files may still import it.
 * Do not use this for new booking turn logic.
 */
export function setPendingBookingStepAnchor(params: {
  realtimeState: CallState;
  nextRequiredStep: any;
  anchorTranscript: string;
  anchorSeq: number;
}): CallState {
  const { realtimeState, nextRequiredStep } = params;

  const nextStepKey = clean(nextRequiredStep?.step_key);

  if (!nextStepKey) {
    return clearBookingTurnState(realtimeState);
  }

  return markBookingWaitingForAssistantPrompt({
    realtimeState: {
      ...realtimeState,
      pendingBookingStepRequired:
        typeof nextRequiredStep?.required === "boolean"
          ? nextRequiredStep.required
          : realtimeState.pendingBookingStepRequired,
    } as CallState,
    stepKey: nextStepKey,
    prompt: clean(nextRequiredStep?.prompt),
  });
}

export function markSubmittedBookingStep(params: {
  realtimeState: CallState;
  submittedStepKey: string;
  submittedTranscript: string;
  submittedTranscriptSeq: number;
}): CallState {
  const {
    realtimeState,
    submittedStepKey,
    submittedTranscript,
    submittedTranscriptSeq,
  } = params;

  return {
    ...realtimeState,
    lastSubmittedBookingStepKey: clean(submittedStepKey),
    lastSubmittedBookingTranscript: clean(submittedTranscript),
    lastSubmittedBookingTranscriptSeq: finiteNumber(submittedTranscriptSeq, -1),
  };
}

export function applyBookingRuntimeStateAfterToolResult(params: {
  realtimeState: CallState;
  toolName: string;
  toolResult: any;
  effectiveToolArgs: Record<string, any>;
  lastUserTranscript: string;
}): CallState {
  const {
    realtimeState,
    toolName,
    toolResult,
    effectiveToolArgs,
    lastUserTranscript,
  } = params;

  const lastUserTranscriptSeq = finiteNumber(
    realtimeState.lastUserTranscriptSeq,
    -1
  );

  let nextState = realtimeState;

  const consumedSubmitValue =
    toolName === "submit_booking_step"
      ? resolveConsumedBookingSubmitValue({
          effectiveToolArgs,
          lastUserTranscript,
        })
      : clean(lastUserTranscript);

  if (toolName === "submit_booking_step" && toolResult?.ok === true) {
    nextState = markSubmittedBookingStep({
      realtimeState: nextState,
      submittedStepKey: clean(effectiveToolArgs.step_key),
      submittedTranscript: consumedSubmitValue,
      submittedTranscriptSeq: lastUserTranscriptSeq,
    });
  }

  if (
    (toolName === "get_booking_flow" || toolName === "submit_booking_step") &&
    toolResult?.next_required_step
  ) {
    const nextStep = toolResult.next_required_step;
    const nextStepKey = clean(nextStep?.step_key);
    const nextPrompt = clean(nextStep?.prompt);

    if (!nextStepKey) {
      nextState = clearBookingTurnState(nextState);
    } else {
      nextState = {
        ...nextState,
        pendingBookingStepRequired:
          typeof nextStep?.required === "boolean"
            ? nextStep.required
            : nextState.pendingBookingStepRequired,
      } as CallState;

      nextState = markBookingWaitingForAssistantPrompt({
        realtimeState: nextState,
        stepKey: nextStepKey,
        prompt: nextPrompt,
      });
    }
  }

  if (
    (toolName === "get_booking_flow" || toolName === "submit_booking_step") &&
    toolResult?.ok === true &&
    !toolResult?.next_required_step
  ) {
    nextState = clearBookingTurnState(nextState);
  }

  return nextState;
}