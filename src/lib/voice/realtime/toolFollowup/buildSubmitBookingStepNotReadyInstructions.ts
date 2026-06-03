//src/lib/voice/realtime/toolFollowup/buildSubmitBookingStepNotReadyInstructions.ts
import type { CallState } from "../../types";
import { clean } from "../utils/clean";

type BuildSubmitBookingStepNotReadyInstructionsParams = {
  realtimeState: CallState;
  reason: string;
};

export function buildSubmitBookingStepNotReadyInstructions(
  params: BuildSubmitBookingStepNotReadyInstructionsParams
): string {
  const pendingPrompt = clean(params.realtimeState.pendingBookingStepPrompt);

  return [
    "The booking step is not ready to accept a submitted answer yet.",
    `Reason: ${params.reason}.`,
    pendingPrompt
      ? `Ask the caller the pending booking question using this configured prompt as source of truth: ${pendingPrompt}`
      : "Ask the caller the pending booking question again using the current booking flow state.",
    "Do not invent booking details, services, dates, times, names, phone numbers, or policies.",
    "Ask only one question.",
  ].join(" ");
}