// src/lib/voice/realtime/toolGuards/validateSubmitBookingStepFreshness.ts
import type { CallState } from "../../types";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeComparableText(value: unknown): string {
  return clean(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sameComparableText(left: unknown, right: unknown): boolean {
  const a = normalizeComparableText(left);
  const b = normalizeComparableText(right);

  return Boolean(a && b && a === b);
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
      isReusedTranscriptFromPreviousStep: boolean;
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
      isReusedTranscriptFromPreviousStep: boolean;
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

  const lastSubmittedStepKey = clean(realtimeState.lastSubmittedBookingStepKey);

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
    sameComparableText(currentTranscript, lastSubmittedTranscript) &&
    currentTranscriptSeq <= lastSubmittedTranscriptSeq;

  /**
   * Regla raíz:
   * Un nuevo step no puede consumir el mismo contenido humano que ya fue usado
   * para resolver un step anterior.
   *
   * Esto no depende de frases, idioma, tenant, servicio, staff ni regex de negocio.
   * Solo protege la máquina de estados.
   */
  const isReusedTranscriptFromPreviousStep =
    Boolean(lastSubmittedStepKey) &&
    Boolean(submittedStepKey) &&
    lastSubmittedStepKey !== submittedStepKey &&
    Boolean(currentTranscript) &&
    sameComparableText(currentTranscript, lastSubmittedTranscript);

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
    isReusedTranscriptFromPreviousStep,
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

  if (
    !hasNewHumanTranscript ||
    isDuplicateSubmit ||
    isReusedTranscriptFromPreviousStep
  ) {
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