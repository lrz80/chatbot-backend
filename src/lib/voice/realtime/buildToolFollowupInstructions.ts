// src/lib/voice/realtime/buildToolFollowupInstructions.ts

export type RealtimeToolResult = {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function buildNaturalPromptInstruction(params: {
  sourceText: string;
  purpose: string;
  mustAskConfirmation?: boolean;
  mustAskSmsOffer?: boolean;
  mustWaitForAnswer?: boolean;
  blockEndCall?: boolean;
}): string {
  const {
    sourceText,
    purpose,
    mustAskConfirmation = false,
    mustAskSmsOffer = false,
    mustWaitForAnswer = true,
    blockEndCall = true,
  } = params;

  return [
    "Use only the tool result as source of truth.",
    `${purpose}: ${sourceText}`,
    "Do not invent booking details, prices, dates, times, services, names, phone numbers, or policies.",
    "Do not read the configured text like an IVR, form, or answering machine.",
    "Rephrase it naturally for a warm human phone conversation.",
    "Preserve the exact meaning, required slot, configured options, service name, date, time, and booking facts.",
    mustAskConfirmation
      ? "The caller must clearly be asked to confirm the booking in this same turn."
      : "",
    mustAskSmsOffer
      ? "The caller must clearly be asked whether they want the booking details by SMS in this same turn."
      : "",
    mustWaitForAnswer ? "Ask only one question and wait for the caller answer." : "",
    blockEndCall ? "Do not call end_call while a required booking step is pending." : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildToolFollowupInstructions(params: {
  toolName: string;
  toolResult: RealtimeToolResult;
}): string {
  const { toolName, toolResult } = params;

  const ok = toolResult?.ok === true;
  const error = clean(toolResult?.error || "");
  const assistantPrompt = clean((toolResult as any)?.assistant_prompt || "");
  const message = clean((toolResult as any)?.message || "");
  const bookingOutcome = clean((toolResult as any)?.booking_outcome || "");
  const actionRequired = clean((toolResult as any)?.action_required || "");
  const requiresSmsDestination =
    (toolResult as any)?.requires_sms_destination === true;
  const hangup = (toolResult as any)?.hangup === true;

  const nextRequiredStep = getObject((toolResult as any)?.next_required_step);

  const nextStepKey = clean(nextRequiredStep?.step_key || "");
  const nextStepPrompt = clean(nextRequiredStep?.prompt || "");
  const nextStepExpectedType = clean(nextRequiredStep?.expected_type || "");
  const nextStepRequired = nextRequiredStep?.required === true;

  const primaryPrompt = assistantPrompt || nextStepPrompt || message;

  /**
   * Important:
   * When final confirmation has been accepted, the model should not speak.
   * It must call create_appointment, otherwise Realtime can drift and say
   * something generic like "I don't have that saved."
   */
  if (actionRequired === "create_appointment") {
    return [
      "Use only the tool result as source of truth.",
      "Do not speak to the caller yet.",
      "Call create_appointment now with no arguments.",
      "Do not ask another booking question.",
      "Do not call end_call.",
    ].join(" ");
  }

  if (
    actionRequired === "awaiting_confirmation" ||
    nextStepKey === "confirm" ||
    nextStepExpectedType === "confirmation"
  ) {
    return buildNaturalPromptInstruction({
      sourceText: primaryPrompt,
      purpose: "Ask the booking confirmation question using this configured meaning",
      mustAskConfirmation: true,
      mustWaitForAnswer: true,
      blockEndCall: true,
    });
  }

  if (toolName === "end_call") {
    if (ok && hangup) {
      return [
        "Use only the tool result as source of truth.",
        "Say a short, natural goodbye.",
        "Do not ask any more questions.",
      ].join(" ");
    }

    return [
      "Use only the tool result as source of truth.",
      "Do not end the call yet.",
      "Continue helping the caller briefly.",
    ].join(" ");
  }

  if (requiresSmsDestination) {
    return buildNaturalPromptInstruction({
      sourceText:
        primaryPrompt ||
        "Ask which phone number should receive the booking details by SMS.",
      purpose: "Ask for the SMS destination phone number",
      mustWaitForAnswer: true,
      blockEndCall: true,
    });
  }

  if (
    actionRequired === "awaiting_offer_booking_sms_confirmation" ||
    bookingOutcome === "confirmed_offer_sms" ||
    nextStepKey === "offer_booking_sms"
  ) {
    return buildNaturalPromptInstruction({
      sourceText: primaryPrompt,
      purpose: "Ask the SMS offer question using this configured meaning",
      mustAskSmsOffer: true,
      mustWaitForAnswer: true,
      blockEndCall: true,
    });
  }

  if (bookingOutcome === "awaiting_sms_destination") {
    return buildNaturalPromptInstruction({
      sourceText:
        primaryPrompt ||
        "Ask which phone number should receive the booking details by SMS.",
      purpose: "Ask for the SMS destination phone number",
      mustWaitForAnswer: true,
      blockEndCall: true,
    });
  }

  if (bookingOutcome === "confirmed" || bookingOutcome === "cancelled") {
    return [
      "Use only the tool result as source of truth.",
      primaryPrompt
        ? `Use this result message as the factual source: ${primaryPrompt}`
        : "Give the caller a brief booking status update.",
      "Speak naturally and warmly.",
      "Do not invent or change booking details.",
      "After that, ask briefly if the caller needs anything else.",
      "If the caller asks for something else, continue helping.",
      "If the caller says no or the conversation is complete, you may end the call.",
    ].join(" ");
  }

  if (assistantPrompt) {
    return buildNaturalPromptInstruction({
      sourceText: assistantPrompt,
      purpose: "Respond using this server-generated message as the factual source",
      mustWaitForAnswer: false,
      blockEndCall: nextStepRequired,
    });
  }

  if (nextStepPrompt) {
    return buildNaturalPromptInstruction({
      sourceText: nextStepPrompt,
      purpose: "Ask the next booking question using this configured meaning",
      mustWaitForAnswer: true,
      blockEndCall: nextStepRequired,
    });
  }

  if (!ok && error) {
    return [
      "Use only the tool result as source of truth.",
      message
        ? `Use this error message as the factual source: ${message}`
        : `The tool returned this error: ${error}`,
      "Explain the issue briefly in a natural phone-call style.",
      "Ask one clear follow-up question only if more information is required.",
      "Do not call end_call unless the conversation is fully complete.",
    ].join(" ");
  }

  if (toolName === "get_booking_flow") {
    return [
      "Use only the tool result as source of truth.",
      "Ask the next required booking question in a natural human phone-call style.",
      "Preserve the configured options and required slot.",
      "Ask one short question only.",
      "Do not call end_call while the booking flow is still active.",
    ].join(" ");
  }

  return [
    "Use only the tool result as source of truth.",
    "Respond briefly and naturally.",
    "Do not invent booking details.",
    "Do not call end_call unless the conversation is fully complete.",
  ].join(" ");
}