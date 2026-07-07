//src/lib/voice/realtime/dashboardVoiceTranscriptContent.ts
import type { CallState } from "../types";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export function resolveDashboardVoiceUserContent(params: {
  rawTranscript: string;
  previousState: CallState;
  nextState: CallState;
}): string | undefined {
  const rawTranscript = clean(params.rawTranscript);

  const previousPendingStep = clean(
    (params.previousState as any)?.pendingBookingStepKey
  );

  const nextPendingStep = clean(
    (params.nextState as any)?.pendingBookingStepKey
  );

  const previousBookingTurnStatus = clean(
    (params.previousState as any)?.bookingTurnStatus
  );

  const nextBookingTurnStatus = clean(
    (params.nextState as any)?.bookingTurnStatus
  );

  const bookingJustStarted =
    !previousPendingStep &&
    Boolean(nextPendingStep);

  if (bookingJustStarted) {
    return "Cliente solicitó iniciar una reserva.";
  }

  const bookingFlowActive =
    Boolean(nextPendingStep) ||
    Boolean(nextBookingTurnStatus) ||
    Boolean(previousPendingStep) ||
    Boolean(previousBookingTurnStatus);

  if (bookingFlowActive && rawTranscript) {
    return rawTranscript;
  }

  return undefined;
}