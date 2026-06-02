// src/lib/voice/realtime/deferredSubmitBookingStep.ts

import type { CallState } from "../types";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function getNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

  /**
   * Solo diferimos cuando todavía no existe un transcript humano nuevo
   * después del prompt actual.
   *
   * No hacemos validación semántica aquí.
   * Este archivo solo controla sincronización transcript/tool-call.
   *
   * La validación real de servicio, staff, número, fecha, teléfono, etc.
   * pertenece a los resolvers del booking step.
   */
  return params.lastUserTranscriptSeq <= promptAnchorSeq;
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

  /**
   * Se mantiene esta propiedad para no romper logs/callers existentes,
   * pero ya no se usa overlap léxico para decidir.
   */
  const modelValueIsSupportedByLastTranscript = true;

  return {
    ok:
      bookingTurnStatus === "waiting_user_answer" &&
      !!submittedStepKey &&
      submittedStepKey === pendingStepKey &&
      hasNewUserTranscript,
    submittedStepKey,
    pendingStepKey,
    bookingTurnStatus,
    promptAnchorSeq,
    hasNewUserTranscript,
    modelValueIsSupportedByLastTranscript,
  };
}