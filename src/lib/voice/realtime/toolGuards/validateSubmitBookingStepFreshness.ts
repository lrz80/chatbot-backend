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

function comparableTokens(value: unknown): string[] {
  return normalizeComparableText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function levenshteinDistance(a: string, b: string): number {
  const left = normalizeComparableText(a);
  const right = normalizeComparableText(b);

  if (!left) return right.length;
  if (!right) return left.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= left.length; i += 1) {
    matrix[i] = [i];
  }

  for (let j = 1; j <= right.length; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;

      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[left.length][right.length];
}

function textSimilarityRatio(a: unknown, b: unknown): number {
  const left = normalizeComparableText(a);
  const right = normalizeComparableText(b);

  if (!left || !right) return 0;
  if (left === right) return 1;

  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) return 0;

  const distance = levenshteinDistance(left, right);

  return 1 - distance / maxLength;
}

function tokenOverlapRatio(a: unknown, b: unknown): number {
  const leftTokens = comparableTokens(a);
  const rightTokens = comparableTokens(b);

  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;

  const rightSet = new Set(rightTokens);
  const shared = leftTokens.filter((token) => rightSet.has(token));

  return shared.length / Math.min(leftTokens.length, rightTokens.length);
}

function isSameOrNearSameHumanAnswer(a: unknown, b: unknown): boolean {
  if (sameComparableText(a, b)) return true;

  const textRatio = textSimilarityRatio(a, b);
  const overlapRatio = tokenOverlapRatio(a, b);

  return textRatio >= 0.82 || overlapRatio >= 0.75;
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
    isSameOrNearSameHumanAnswer(currentTranscript, lastSubmittedTranscript);

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