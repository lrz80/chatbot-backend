// src/lib/voice/realtime/toolFollowup/buildSubmitBookingStepNotReadyInstructions.ts
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
  const reason = clean(params.reason);

  if (pendingPrompt) {
    return [
      "The booking step is not ready to accept a submitted answer yet.",
      reason ? `Reason: ${reason}.` : "",
      "Say exactly the pending booking prompt and nothing else.",
      "Do not rephrase it.",
      "Do not add confirmations, transitions, explanations, status updates, filler words, or extra questions.",
      "Do not mention availability checks, calendar checks, validation, tools, processing, or internal steps.",
      "After saying the prompt, stop and wait for the caller answer.",
      "",
      pendingPrompt,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    "The booking step is not ready to accept a submitted answer yet.",
    reason ? `Reason: ${reason}.` : "",
    "Ask the current pending booking question again.",
    "Do not invent booking details, services, dates, times, names, phone numbers, prices, or policies.",
    "Ask only one question.",
    "Do not mention availability checks, calendar checks, validation, tools, processing, or internal steps.",
  ]
    .filter(Boolean)
    .join("\n");
}