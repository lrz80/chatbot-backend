// src/lib/voice/realtime/toolGuards/validateSubmitBookingStepFreshness.ts
import type { CallState } from "../../types";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export type SubmitBookingStepFreshnessResult =
  | {
      ok: true;
      submittedStepKey: string;
      pendingStepKey: string;
      currentTranscript: string;
      promptAnchorTranscript: string;
      lastSubmittedStepKey: string;
      lastSubmittedTranscript: string;
      hasPendingStepState: boolean;
      hasPromptAnchorTranscript: boolean;
      isSubmittingExpectedPendingStep: boolean;
      currentTranscriptSeq: number;
      promptAnchorSeq: number;
      lastSubmittedTranscriptSeq: number;
      hasNewHumanTranscript: boolean;
      isDuplicateSubmit: boolean;
      shouldBlockStaleSubmit: false;
    }
  | {
      ok: false;
      error: "BOOKING_STEP_WAITING_FOR_NEW_USER_INPUT";
      submittedStepKey: string;
      pendingStepKey: string;
      currentTranscript: string;
      promptAnchorTranscript: string;
      lastSubmittedStepKey: string;
      lastSubmittedTranscript: string;
      hasPendingStepState: boolean;
      hasPromptAnchorTranscript: boolean;
      isSubmittingExpectedPendingStep: boolean;
      currentTranscriptSeq: number;
      promptAnchorSeq: number;
      lastSubmittedTranscriptSeq: number;
      hasNewHumanTranscript: boolean;
      isDuplicateSubmit: boolean;
      shouldBlockStaleSubmit: true;
    };

export function validateSubmitBookingStepFreshness(params: {
  toolArgs: Record<string, any>;
  realtimeState: CallState;
  lastUserTranscript: string;
}): SubmitBookingStepFreshnessResult {
  const { toolArgs, realtimeState, lastUserTranscript } = params;

  const submittedStepKey = clean(toolArgs.step_key);
  const pendingStepKey = clean(realtimeState.pendingBookingStepKey);
  const currentTranscript = clean(lastUserTranscript);

  const promptAnchorTranscript = clean(
    realtimeState.pendingBookingStepPromptAnchorTranscript
  );

  const lastSubmittedStepKey = clean(
    realtimeState.lastSubmittedBookingStepKey
  );

  const lastSubmittedTranscript = clean(
    realtimeState.lastSubmittedBookingTranscript
  );

  const currentTranscriptSeq =
    typeof realtimeState.lastUserTranscriptSeq === "number"
      ? realtimeState.lastUserTranscriptSeq
      : 0;

  const promptAnchorSeq =
    typeof realtimeState.pendingBookingStepPromptAnchorSeq === "number"
      ? realtimeState.pendingBookingStepPromptAnchorSeq
      : -1;

  const lastSubmittedTranscriptSeq =
    typeof realtimeState.lastSubmittedBookingTranscriptSeq === "number"
      ? realtimeState.lastSubmittedBookingTranscriptSeq
      : -1;

  const hasPendingStepState = Boolean(pendingStepKey);
  const hasPromptAnchorTranscript =
    Boolean(promptAnchorTranscript) && promptAnchorSeq >= 0;

  const isSubmittingExpectedPendingStep =
    hasPendingStepState &&
    Boolean(submittedStepKey) &&
    submittedStepKey === pendingStepKey;

  const hasNewHumanTranscript =
    Boolean(currentTranscript) &&
    hasPromptAnchorTranscript &&
    currentTranscriptSeq > promptAnchorSeq;

  const isDuplicateSubmit =
    Boolean(submittedStepKey) &&
    submittedStepKey === lastSubmittedStepKey &&
    Boolean(currentTranscript) &&
    currentTranscript === lastSubmittedTranscript &&
    currentTranscriptSeq === lastSubmittedTranscriptSeq;

  const shouldBlockStaleSubmit =
    !hasPendingStepState ||
    !hasPromptAnchorTranscript ||
    !isSubmittingExpectedPendingStep ||
    !hasNewHumanTranscript ||
    isDuplicateSubmit;

  const base = {
    submittedStepKey,
    pendingStepKey,
    currentTranscript,
    promptAnchorTranscript,
    lastSubmittedStepKey,
    lastSubmittedTranscript,
    hasPendingStepState,
    hasPromptAnchorTranscript,
    isSubmittingExpectedPendingStep,
    currentTranscriptSeq,
    promptAnchorSeq,
    lastSubmittedTranscriptSeq,
    hasNewHumanTranscript,
    isDuplicateSubmit,
  };

  if (shouldBlockStaleSubmit) {
    return {
      ok: false,
      error: "BOOKING_STEP_WAITING_FOR_NEW_USER_INPUT",
      ...base,
      shouldBlockStaleSubmit: true,
    };
  }

  return {
    ok: true,
    ...base,
    shouldBlockStaleSubmit: false,
  };
}