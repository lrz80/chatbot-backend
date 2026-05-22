// src/lib/voice/realtime/bookingRuntimeState.ts
import type { CallState } from "../types";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

function pickDefined<T>(primary: T | undefined, fallback: T | undefined): T | undefined {
  return typeof primary !== "undefined" ? primary : fallback;
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

    bookingData:
      Object.keys(currentToolState.bookingData || {}).length > 0
        ? currentToolState.bookingData
        : transcriptState.bookingData,

    pendingBookingStepKey: pickDefined(
      currentToolState.pendingBookingStepKey,
      transcriptState.pendingBookingStepKey
    ),

    pendingBookingStepRequired: pickDefined(
      currentToolState.pendingBookingStepRequired,
      transcriptState.pendingBookingStepRequired
    ),

    pendingBookingStepPrompt: pickDefined(
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
  };
}

export function clearPendingBookingStepAnchor(realtimeState: CallState): CallState {
  return {
    ...realtimeState,
    pendingBookingStepKey: "",
    pendingBookingStepRequired: undefined,
    pendingBookingStepPrompt: "",
    pendingBookingStepPromptAnchorTranscript: "",
    pendingBookingStepPromptAnchorSeq: -1,
  };
}

export function setPendingBookingStepAnchor(params: {
  realtimeState: CallState;
  nextRequiredStep: any;
  lastUserTranscript: string;
  lastUserTranscriptSeq: number;
}): CallState {
  const {
    realtimeState,
    nextRequiredStep,
    lastUserTranscript,
    lastUserTranscriptSeq,
  } = params;

  const nextStepKey = clean(nextRequiredStep?.step_key);

  if (!nextStepKey) {
    return clearPendingBookingStepAnchor(realtimeState);
  }

  return {
    ...realtimeState,
    pendingBookingStepKey: nextStepKey,
    pendingBookingStepRequired:
      typeof nextRequiredStep?.required === "boolean"
        ? nextRequiredStep.required
        : realtimeState.pendingBookingStepRequired,
    pendingBookingStepPrompt: clean(nextRequiredStep?.prompt),
    pendingBookingStepPromptAnchorTranscript: clean(lastUserTranscript),
    pendingBookingStepPromptAnchorSeq: finiteNumber(lastUserTranscriptSeq, -1),
  };
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

  if (toolName === "submit_booking_step" && toolResult?.ok === true) {
    nextState = markSubmittedBookingStep({
      realtimeState: nextState,
      submittedStepKey: clean(effectiveToolArgs.step_key),
      submittedTranscript: lastUserTranscript,
      submittedTranscriptSeq: lastUserTranscriptSeq,
    });
  }

  if (
    (toolName === "get_booking_flow" || toolName === "submit_booking_step") &&
    toolResult?.next_required_step
  ) {
    nextState = setPendingBookingStepAnchor({
      realtimeState: nextState,
      nextRequiredStep: toolResult.next_required_step,
      lastUserTranscript,
      lastUserTranscriptSeq,
    });
  }

  if (
    (toolName === "get_booking_flow" || toolName === "submit_booking_step") &&
    toolResult?.ok === true &&
    !toolResult?.next_required_step
  ) {
    nextState = clearPendingBookingStepAnchor(nextState);
  }

  return nextState;
}