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
      effectiveAnchorSeq: number;
      hasNewHumanTranscript: boolean;
      isDuplicateSubmit: boolean;
      shouldBlockStaleSubmit: false;
    }
  | {
      ok: false;
      error:
        | "BOOKING_STEP_WAITING_FOR_PENDING_STEP"
        | "BOOKING_STEP_UNEXPECTED_STEP"
        | "BOOKING_STEP_WAITING_FOR_NEW_USER_INPUT";
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
      effectiveAnchorSeq: number;
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

  /**
   * Fuente de verdad para frescura:
   *
   * 1. Si existe promptAnchorSeq, usamos ese punto como referencia.
   * 2. Si no existe anchor por algún problema de timing, usamos el último transcript ya enviado.
   * 3. Nunca bloqueamos solo porque el texto del anchor esté vacío.
   *
   * Esto evita el loop donde el cliente sí respondió, pero el guard bloquea porque
   * pendingBookingStepPromptAnchorTranscript nunca fue seteado.
   */
  const effectiveAnchorSeq = Math.max(
    promptAnchorSeq,
    lastSubmittedTranscriptSeq
  );

  const hasNewHumanTranscript =
    Boolean(currentTranscript) && currentTranscriptSeq > effectiveAnchorSeq;

  const isDuplicateSubmit =
    Boolean(submittedStepKey) &&
    submittedStepKey === lastSubmittedStepKey &&
    Boolean(currentTranscript) &&
    currentTranscript === lastSubmittedTranscript &&
    currentTranscriptSeq <= lastSubmittedTranscriptSeq;

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
    effectiveAnchorSeq,
    hasNewHumanTranscript,
    isDuplicateSubmit,
  };

  if (!hasPendingStepState) {
    return {
      ok: false,
      error: "BOOKING_STEP_WAITING_FOR_PENDING_STEP",
      ...base,
      shouldBlockStaleSubmit: true,
    };
  }

  if (!isSubmittingExpectedPendingStep) {
    return {
      ok: false,
      error: "BOOKING_STEP_UNEXPECTED_STEP",
      ...base,
      shouldBlockStaleSubmit: true,
    };
  }

  if (!hasNewHumanTranscript || isDuplicateSubmit) {
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