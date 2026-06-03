// src/lib/voice/realtime/toolFollowup/buildSyntheticBookingStepFollowupInstructions.ts

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function joinInstructions(parts: string[]): string {
  return parts.filter(Boolean).join(" ");
}

export function buildSyntheticBookingStepFollowupInstructions(params: {
  toolName: string;
  toolResult: any;
  currentLocale?: string;
}): string {
  const toolName = clean(params.toolName);
  const activeLocale = clean(params.currentLocale);

  if (toolName !== "submit_booking_step") {
    return "";
  }

  const nextStep = params.toolResult?.next_required_step;
  const prompt = clean(nextStep?.prompt);
  const retryPrompt = clean(nextStep?.retry_prompt);

  if (params.toolResult?.ok === true && prompt) {
    return joinInstructions([
      "Continue the booking flow now.",
      activeLocale
        ? `Respond in the active call language: ${activeLocale}. Do not switch languages unless the caller clearly switches languages in a later user turn.`
        : "",
      "Use only the next booking step prompt below as source of truth.",
      `Say this prompt naturally now: ${prompt}`,
      "Ask only this one question.",
      "Wait for the caller answer.",
      "Do not call another tool before the caller answers.",
      "Do not repeat the previous booking step.",
      "Do not invent booking details, services, dates, times, names, phone numbers, addresses, prices, or policies.",
    ]);
  }

  if (params.toolResult?.ok === false && (retryPrompt || prompt)) {
    return joinInstructions([
      "The caller answer was not valid for the current booking step.",
      activeLocale
        ? `Respond in the active call language: ${activeLocale}. Do not switch languages unless the caller clearly switches languages in a later user turn.`
        : "",
      "Use only the retry prompt below as source of truth.",
      `Say this retry prompt naturally now: ${retryPrompt || prompt}`,
      "Ask only this one question.",
      "Wait for the caller answer.",
      "Do not call another tool before the caller answers.",
      "Do not invent booking details, services, dates, times, names, phone numbers, addresses, prices, or policies.",
    ]);
  }

  return "";
}