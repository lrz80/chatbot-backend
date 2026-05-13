//src/lib/voice/realtime/buildToolFollowupInstructions.ts
export type RealtimeToolResult = {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export function buildToolFollowupInstructions(params: {
  toolName: string;
  toolResult: RealtimeToolResult;
}): string {
  const { toolName, toolResult } = params;

  const ok = toolResult?.ok === true;
  const error = clean(toolResult?.error || "");
  const assistantPrompt = clean((toolResult as any)?.assistant_prompt || "");
  const bookingOutcome = clean((toolResult as any)?.booking_outcome || "");
  const actionRequired = clean((toolResult as any)?.action_required || "");
  const requiresSmsDestination =
    (toolResult as any)?.requires_sms_destination === true;
  const hangup = (toolResult as any)?.hangup === true;

  const nextRequiredStep =
    toolResult &&
    typeof toolResult.next_required_step === "object" &&
    toolResult.next_required_step !== null
      ? (toolResult.next_required_step as Record<string, unknown>)
      : null;

  const nextStepKey = clean(nextRequiredStep?.step_key || "");
  const nextStepPrompt = clean(nextRequiredStep?.prompt || "");

  if (
    actionRequired === "awaiting_confirmation" ||
    nextStepKey === "confirm"
  ) {
    return [
      "Use only the tool result as source of truth.",
      `Say exactly this confirmation question: ${assistantPrompt || nextStepPrompt}`,
      "Do not shorten it.",
      "Do not paraphrase it.",
      "Do not remove the final confirmation question.",
      "Wait for the caller answer.",
      "Do not call create_appointment yet.",
      "Do not call end_call.",
    ].join(" ");
  }

  if (toolName === "end_call") {
    if (ok && hangup) {
      return [
        "Say a short goodbye only.",
        "Do not ask any more questions.",
      ].join(" ");
    }

    return [
      "Do not end the call yet.",
      "Continue helping the caller briefly.",
    ].join(" ");
  }

  if (requiresSmsDestination) {
    return [
      "Use only the tool result as source of truth.",
      "Ask exactly this question: What phone number should receive the booking details by SMS?",
      "Ask one short question only.",
      "Do not call end_call.",
      "Wait for the caller answer.",
    ].join(" ");
  }

  if (
    bookingOutcome === "confirmed_offer_sms" ||
    nextStepKey === "offer_booking_sms"
  ) {
    return [
      "Use only the tool result as source of truth.",
      `Say exactly this message: ${assistantPrompt || nextStepPrompt}`,
      "This is not the end of the call.",
      "Do not call end_call.",
      "Wait for the caller answer to the SMS offer.",
    ].join(" ");
  }

  if (
    bookingOutcome === "awaiting_sms_destination"
  ) {
    return [
      "Use only the tool result as source of truth.",
      "Ask exactly which phone number should receive the booking details by SMS.",
      "Ask one short question only.",
      "Do not call end_call.",
      "Wait for the caller answer.",
    ].join(" ");
  }

  if (
    bookingOutcome === "confirmed" ||
    bookingOutcome === "cancelled"
  ) {
    return [
      "Use only the tool result as source of truth.",
      `Say exactly this message: ${assistantPrompt}`,
      "After that, ask briefly if the caller needs anything else.",
      "If the caller asks for something else, continue helping.",
      "If the caller says no or the conversation is complete, you may end the call.",
    ].join(" ");
  }

  if (assistantPrompt) {
    return [
      "Use only the tool result as source of truth.",
      `Say exactly this message: ${assistantPrompt}`,
      "Do not add or remove booking details.",
    ].join(" ");
  }

  if (nextStepPrompt) {
    return [
      "Use only the tool result as source of truth.",
      `Ask exactly this next question: ${nextStepPrompt}`,
      "Ask one short question only.",
      "Do not call end_call while a required step is still pending.",
    ].join(" ");
  }

  if (!ok && error) {
    return [
      "Use only the tool result as source of truth.",
      "Explain the issue briefly.",
      "Ask one clear follow-up question only if the tool result requires more information.",
      "Do not call end_call unless the conversation is fully complete.",
    ].join(" ");
  }

  if (toolName === "get_booking_flow") {
    return [
      "Use only the tool result as source of truth.",
      "Ask the next required booking question only.",
      "Ask one short question only.",
      "Do not call end_call while the booking flow is still active.",
    ].join(" ");
  }

  return [
    "Use only the tool result as source of truth.",
    "Respond briefly.",
    "Do not call end_call unless the conversation is fully complete.",
  ].join(" ");
}