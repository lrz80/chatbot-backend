// src/lib/voice/realtime/toolFollowup/resolveRealtimeToolFollowupInstructions.ts
import {
  buildToolFollowupInstructions,
  type RealtimeToolResult,
} from "../buildToolFollowupInstructions";

export function resolveRealtimeToolFollowupInstructions(params: {
  toolName: string;
  toolResult: RealtimeToolResult;
}): string {
  const { toolName, toolResult } = params;

  if (toolName === "send_booking_sms" && toolResult?.ok === true) {
    return [
      "Use only the tool result as source of truth.",
      "Tell the caller briefly that the booking details were sent by SMS.",
      "Then ask if they need anything else.",
      "Ask only one question and wait for the caller answer.",
      "Do not call end_call until the caller answers this final question.",
      "Do not invent booking details, prices, dates, times, services, names, phone numbers, or policies.",
    ].join(" ");
  }

  return buildToolFollowupInstructions({
    toolName,
    toolResult,
  });
}