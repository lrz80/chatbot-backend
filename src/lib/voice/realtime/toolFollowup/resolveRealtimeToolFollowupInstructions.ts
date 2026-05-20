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

  if (
    toolName === "create_appointment" &&
    toolResult?.error === "SQUARE_WRITE_OPERATIONS_NOT_SUPPORTED"
  ) {
    return [
      "Use only the tool result as source of truth.",
      "The requested appointment time was available, but the connected Square account could not complete the booking automatically.",
      "Do not say the appointment is confirmed.",
      "Do not say the time is unavailable.",
      "Do not invent a booking link, payment link, policy, price, deposit, or confirmation number.",
      "Explain briefly and naturally that the booking needs to be completed through the business official booking link if one is available.",
      "Ask the caller whether they want to receive the official booking link by SMS.",
      "If the caller says yes, call send_useful_link_sms with link_types ['booking', 'square_booking', 'appointments'].",
      "Ask only one question and wait for the caller answer.",
      "Do not call end_call yet.",
    ].join(" ");
  }

  if (toolName === "send_useful_link_sms") {
    if (toolResult?.ok === true) {
      return [
        "Use only the tool result as source of truth.",
        "Tell the caller briefly that the official link was sent by SMS.",
        "Then ask if they need anything else.",
        "Ask only one question and wait for the caller answer.",
        "Do not call end_call until the caller answers this final question.",
        "Do not invent booking confirmations, prices, deposits, policies, or appointment details.",
      ].join(" ");
    }

    return [
      "Use only the tool result as source of truth.",
      "Tell the caller briefly that the official link could not be sent by SMS.",
      "Do not invent a booking link.",
      "Do not say the appointment is confirmed.",
      "Ask if they would like help with anything else.",
      "Ask only one question and wait for the caller answer.",
    ].join(" ");
  }

  return buildToolFollowupInstructions({
    toolName,
    toolResult,
  });
}