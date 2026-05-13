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
  const requiresSmsDestination =
    (toolResult as any)?.requires_sms_destination === true;
  const hangup = (toolResult as any)?.hangup === true;

  const nextRequiredStep =
    toolResult &&
    typeof toolResult.next_required_step === "object" &&
    toolResult.next_required_step !== null
      ? (toolResult.next_required_step as Record<string, unknown>)
      : null;

  const nextStepPrompt = clean(nextRequiredStep?.prompt || "");

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
    ].join(" ");
  }

  if (assistantPrompt) {
    if (toolName === "submit_booking_step" || toolName === "create_appointment") {
      return [
        "Use only the tool result as source of truth.",
        `Say exactly this message: ${assistantPrompt}`,
        "Do not add or remove booking details.",
      ].join(" ");
    }

    return [
      "Use only the tool result as source of truth.",
      `Say exactly this message: ${assistantPrompt}`,
    ].join(" ");
  }

  if (nextStepPrompt) {
    return [
      "Use only the tool result as source of truth.",
      `Ask exactly this next question: ${nextStepPrompt}`,
      "Ask one short question only.",
    ].join(" ");
  }

  if (!ok && error) {
    return [
      "Use only the tool result as source of truth.",
      "Explain the issue briefly.",
      "Ask one clear follow-up question only if the tool result requires more information.",
    ].join(" ");
  }

  if (toolName === "get_booking_flow") {
    return [
      "Use only the tool result as source of truth.",
      "Ask the next required booking question only.",
      "Ask one short question only.",
    ].join(" ");
  }

  return [
    "Use only the tool result as source of truth.",
    "Respond briefly.",
  ].join(" ");
}