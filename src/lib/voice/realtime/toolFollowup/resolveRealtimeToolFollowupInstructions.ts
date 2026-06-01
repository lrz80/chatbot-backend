// src/lib/voice/realtime/toolFollowup/resolveRealtimeToolFollowupInstructions.ts
import {
  buildToolFollowupInstructions,
  type RealtimeToolResult,
} from "../buildToolFollowupInstructions";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function buildActiveLocaleInstruction(currentLocale?: string): string {
  const activeLocale = clean(currentLocale);

  return activeLocale
    ? `Respond in the active call language: ${activeLocale}. Do not switch languages unless the caller clearly switches languages in a later user turn.`
    : "";
}

function joinInstructions(parts: string[]): string {
  return parts.filter(Boolean).join(" ");
}

export function resolveRealtimeToolFollowupInstructions(params: {
  toolName: string;
  toolResult: RealtimeToolResult;
  currentLocale?: string;
}): string {
  const { toolName, toolResult } = params;
  const activeLocaleInstruction = buildActiveLocaleInstruction(
    params.currentLocale
  );

  if (toolName === "send_booking_sms" && toolResult?.ok === true) {
    return joinInstructions([
      "Use only the tool result as source of truth.",
      activeLocaleInstruction,
      "Tell the caller briefly that the booking details were sent by SMS.",
      "Then ask if they need anything else.",
      "Ask only one question and wait for the caller answer.",
      "Do not call end_call until the caller answers this final question.",
      "Do not invent booking details, prices, dates, times, services, names, phone numbers, or policies.",
    ]);
  }

  if (
    toolName === "create_appointment" &&
    toolResult?.error === "SQUARE_WRITE_OPERATIONS_NOT_SUPPORTED"
  ) {
    return joinInstructions([
      "Use only the tool result as source of truth.",
      activeLocaleInstruction,
      "The requested appointment time was available, but the appointment could not be completed automatically right now.",
      "Do not mention Square, payment providers, API errors, subscriptions, plans, integrations, or technical reasons to the caller.",
      "Do not say the appointment is confirmed.",
      "Do not say the time is unavailable.",
      "Do not invent a booking link, payment link, policy, price, deposit, or confirmation number.",
      "Explain briefly and naturally that the reservation must be completed through the business official booking link.",
      "Ask the caller whether they want to receive the official booking link by SMS.",
      "If the caller says yes, call send_useful_link_sms with link_types ['booking', 'square_booking', 'appointments'].",
      "Ask only one question and wait for the caller answer.",
      "Do not call end_call yet.",
    ]);
  }

  if (toolName === "send_useful_link_sms") {
    if (toolResult?.ok === true) {
      return joinInstructions([
        "Use only the tool result as source of truth.",
        activeLocaleInstruction,
        "Tell the caller briefly that the official link was sent by SMS.",
        "Then ask if they need anything else.",
        "Ask only one question and wait for the caller answer.",
        "Do not call end_call until the caller answers this final question.",
        "Do not invent booking confirmations, prices, deposits, policies, or appointment details.",
      ]);
    }

    return joinInstructions([
      "Use only the tool result as source of truth.",
      activeLocaleInstruction,
      "Tell the caller briefly that the official link could not be sent by SMS.",
      "Do not invent a booking link.",
      "Do not say the appointment is confirmed.",
      "Ask if they would like help with anything else.",
      "Ask only one question and wait for the caller answer.",
    ]);
  }

  return buildToolFollowupInstructions({
    toolName,
    toolResult,
    currentLocale: params.currentLocale,
  });
}