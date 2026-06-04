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
  activeLocale?: string;
  mustAskConfirmation?: boolean;
  mustAskSmsOffer?: boolean;
  mustWaitForAnswer?: boolean;
  blockEndCall?: boolean;
}): string {
  const {
    sourceText,
    purpose,
    activeLocale = "",
    mustAskConfirmation = false,
    mustAskSmsOffer = false,
    mustWaitForAnswer = true,
    blockEndCall = true,
  } = params;

  return [
    "Use only the tool result as source of truth.",
    activeLocale
      ? `Respond in the active call language: ${activeLocale}. Do not switch languages unless the caller clearly switches languages in a later user turn.`
      : "",
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
  currentLocale?: string;
}): string {
  const { toolName, toolResult } = params;
  const activeLocale = clean(params.currentLocale || "");

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

  if (actionRequired === "send_booking_sms") {
    return [
      "Use only the tool result as source of truth.",
      "Do not speak to the caller yet.",
      "Call send_booking_sms now with no arguments.",
      "Do not call end_call.",
    ].join(" ");
  }

  if (actionRequired === "skip_booking_sms") {
    return [
      "Use only the tool result as source of truth.",
      primaryPrompt
        ? `Respond using this server-generated message as the factual source: ${primaryPrompt}`
        : "Tell the caller the SMS will not be sent.",
      "Speak naturally and warmly.",
      "Ask briefly if the caller needs anything else.",
      "Do not call end_call in this same turn.",
      "Only call end_call after the caller says they do not need anything else or clearly ends the conversation.",
    ].join(" ");
  }

  if (
    actionRequired === "awaiting_offer_booking_sms_confirmation" ||
    bookingOutcome === "confirmed_offer_sms" ||
    nextStepKey === "offer_booking_sms"
  ) {
    return buildNaturalPromptInstruction({
      sourceText: primaryPrompt,
      purpose: "Ask the SMS offer question using this configured meaning",
      activeLocale,
      mustAskSmsOffer: true,
      mustWaitForAnswer: true,
      blockEndCall: true,
    });
  }

  if (
    actionRequired === "awaiting_confirmation" ||
    nextStepKey === "confirm" ||
    nextStepExpectedType === "confirmation"
  ) {
    return [
      "Use only the tool result as source of truth.",
      activeLocale
        ? `Respond in the active call language: ${activeLocale}. Do not switch languages unless the caller clearly switches languages in a later user turn.`
        : "",
      `Confirmation prompt source: ${primaryPrompt}`,
      "Ask the caller to confirm the booking in this same turn.",
      "The response must include a clear confirmation question equivalent to the configured prompt.",
      "Do not omit the confirmation question.",
      "Do not turn the confirmation into only a statement.",
      "Do not invent or change the service, date, time, name, phone number, address, or booking facts.",
      "Ask only this confirmation question and wait for the caller answer.",
      "Do not call create_appointment until the caller answers this confirmation question.",
      "Do not call end_call while confirmation is pending.",
    ]
      .filter(Boolean)
      .join(" ");
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
      activeLocale,
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
      activeLocale,
      mustWaitForAnswer: true,
      blockEndCall: true,
    });
  }

  if (bookingOutcome === "confirmed" || bookingOutcome === "cancelled") {
    return [
      "Use only the tool result as source of truth.",
      activeLocale
        ? `Respond in the active call language: ${activeLocale}. Do not switch languages unless the caller clearly switches languages in a later user turn.`
        : "",
      primaryPrompt
        ? `Use this result message as the factual source: ${primaryPrompt}`
        : "Give the caller a brief booking status update.",
      "Speak naturally and warmly.",
      "Do not invent or change booking details.",
      "After that, ask briefly if the caller needs anything else.",
      "If the caller asks for something else, continue helping.",
      "If the caller says no or the conversation is complete, you may end the call.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (assistantPrompt) {
    return buildNaturalPromptInstruction({
      sourceText: assistantPrompt,
      purpose: "Respond using this server-generated message as the factual source",
      activeLocale,
      mustWaitForAnswer: false,
      blockEndCall: nextStepRequired,
    });
  }

  if (nextStepPrompt) {
    return buildNaturalPromptInstruction({
      sourceText: nextStepPrompt,
      purpose: "Ask the next booking question using this configured meaning",
      activeLocale,
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
      activeLocale
        ? `Respond in the active call language: ${activeLocale}. Do not switch languages unless the caller clearly switches languages in a later user turn.`
        : "",
      nextStepPrompt
        ? `Ask this next required booking question using this configured meaning: ${nextStepPrompt}`
        : "Ask the next required booking question in a natural human phone-call style.",
      "Preserve the configured options and required slot.",
      "Ask one short question only.",
      "Do not call end_call while the booking flow is still active.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  return [
    "Use only the tool result as source of truth.",
    "Respond briefly and naturally.",
    "Do not invent booking details.",
    "Do not call end_call unless the conversation is fully complete.",
  ].join(" ");
}