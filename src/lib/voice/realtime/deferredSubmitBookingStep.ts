// src/lib/voice/realtime/deferredSubmitBookingStep.ts

import type { CallState } from "../types";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function getNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeLoose(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getMeaningfulTokens(value: string): string[] {
  return normalizeLoose(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
}

function hasMeaningfulTokenOverlap(params: {
  transcriptValue: string;
  modelValue: string;
}): boolean {
  const transcript = normalizeLoose(params.transcriptValue);
  const modelTokens = getMeaningfulTokens(params.modelValue);

  if (!transcript || modelTokens.length === 0) {
    return false;
  }

  return modelTokens.some((token) => transcript.includes(token));
}

function isStepThatNeedsTranscriptSupport(params: {
  submittedStepKey: string;
  pendingStepKey: string;
}): boolean {
  const submittedStepKey = normalizeLoose(params.submittedStepKey);
  const pendingStepKey = normalizeLoose(params.pendingStepKey);

  /**
   * Importante:
   * Aquí NO metemos todos los steps.
   *
   * service y staff son los que más se rompen cuando el modelo se adelanta
   * al transcript final.
   *
   * No meto datetime todavía porque "mañana a las 9" puede convertirse a
   * un valor normalizado distinto y un overlap simple puede bloquearlo de más.
   */
  const guardedStepKeys = new Set(["service", "staff"]);

  return guardedStepKeys.has(submittedStepKey) || guardedStepKeys.has(pendingStepKey);
}

export function getRealtimeToolName(event: any): string {
  return clean(event?.name || event?.function?.name || event?.toolName);
}

export function parseRealtimeToolArgs(event: any): Record<string, unknown> {
  const rawArgs =
    event?.arguments ??
    event?.function?.arguments ??
    event?.toolArgs ??
    {};

  if (typeof rawArgs === "string") {
    try {
      const parsed = JSON.parse(rawArgs);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  return rawArgs && typeof rawArgs === "object" ? rawArgs : {};
}

export type DeferredSubmitBookingStepState = {
  event: any | null;
  reason: string | null;
};

export function shouldDeferSubmitBookingStepUntilTranscript(params: {
  event: any;
  realtimeState: CallState;
  lastUserTranscript: string;
  lastUserTranscriptSeq: number;
}): boolean {
  const toolName = getRealtimeToolName(params.event);

  if (toolName !== "submit_booking_step") {
    return false;
  }

  const args = parseRealtimeToolArgs(params.event);

  const submittedStepKey = clean(args.step_key);
  const pendingStepKey = clean((params.realtimeState as any).pendingBookingStepKey);
  const bookingTurnStatus = clean((params.realtimeState as any).bookingTurnStatus);

  if (!submittedStepKey || !pendingStepKey) {
    return false;
  }

  if (submittedStepKey !== pendingStepKey) {
    return false;
  }

  if (bookingTurnStatus !== "waiting_user_answer") {
    return false;
  }

  const promptAnchorSeq = getNumber(
    (params.realtimeState as any).pendingBookingStepPromptAnchorSeq
  );

  if (promptAnchorSeq === null) {
    return false;
  }

  const hasNoNewTranscript =
    params.lastUserTranscriptSeq <= promptAnchorSeq;

  if (hasNoNewTranscript) {
    return true;
  }

  const modelValue = clean(args.value);
  const lastTranscript = clean(params.lastUserTranscript);

  if (!modelValue || !lastTranscript) {
    return false;
  }

  const needsTranscriptSupport = isStepThatNeedsTranscriptSupport({
    submittedStepKey,
    pendingStepKey,
  });

  if (!needsTranscriptSupport) {
    return false;
  }

  const modelValueIsSupportedByLastTranscript = hasMeaningfulTokenOverlap({
    transcriptValue: lastTranscript,
    modelValue,
  });

  return !modelValueIsSupportedByLastTranscript;
}

export function canFlushDeferredSubmitBookingStep(params: {
  event: any;
  realtimeState: CallState;
  lastUserTranscript: string;
  lastUserTranscriptSeq: number;
}): {
  ok: boolean;
  submittedStepKey: string;
  pendingStepKey: string;
  bookingTurnStatus: string;
  promptAnchorSeq: number | null;
  hasNewUserTranscript: boolean;
  modelValueIsSupportedByLastTranscript: boolean;
} {
  const args = parseRealtimeToolArgs(params.event);

  const submittedStepKey = clean(args.step_key);
  const pendingStepKey = clean((params.realtimeState as any).pendingBookingStepKey);
  const bookingTurnStatus = clean((params.realtimeState as any).bookingTurnStatus);

  const promptAnchorSeq = getNumber(
    (params.realtimeState as any).pendingBookingStepPromptAnchorSeq
  );

  const hasNewUserTranscript =
    promptAnchorSeq !== null && params.lastUserTranscriptSeq > promptAnchorSeq;

  const modelValue = clean(args.value);
  const lastTranscript = clean(params.lastUserTranscript);

  const needsTranscriptSupport = isStepThatNeedsTranscriptSupport({
    submittedStepKey,
    pendingStepKey,
  });

  const modelValueIsSupportedByLastTranscript =
    !needsTranscriptSupport ||
    !modelValue ||
    hasMeaningfulTokenOverlap({
      transcriptValue: lastTranscript,
      modelValue,
    });

  return {
    ok:
      bookingTurnStatus === "waiting_user_answer" &&
      !!submittedStepKey &&
      submittedStepKey === pendingStepKey &&
      hasNewUserTranscript &&
      modelValueIsSupportedByLastTranscript,
    submittedStepKey,
    pendingStepKey,
    bookingTurnStatus,
    promptAnchorSeq,
    hasNewUserTranscript,
    modelValueIsSupportedByLastTranscript,
  };
}