// src/lib/voice/realtime/toolFollowup/buildSyntheticBookingStepFollowupInstructions.ts

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function joinInstructions(parts: string[]): string {
  return parts.filter(Boolean).join("\n");
}

function buildBookingStepPromptInstructions(params: {
  prompt: string;
  activeLocale: string;
  mode: "next_step" | "retry_step";
}): string {
  const prompt = clean(params.prompt);
  const activeLocale = clean(params.activeLocale);

  if (!prompt) return "";

  const flowContext =
    params.mode === "retry_step"
      ? "The caller answer was not valid for the current booking step, so you must ask again using the configured retry prompt."
      : "The previous booking step was accepted, and the backend selected the next required booking step.";

  return joinInstructions([
    "You are in a live phone booking flow.",
    flowContext,
    activeLocale
      ? `Respond in the active call language: ${activeLocale}. Do not switch languages unless the caller clearly switches languages in a later user turn.`
      : "",

    "",
    "Naturalness rule:",
    "You may use at most one very short, neutral transition before the prompt, such as the equivalent of “Claro,” “Entendido,” or “Perfecto,” in the active language.",
    "Do not use a transition if it would imply the appointment is already booked, confirmed, reserved, created, or completed.",

    "",
    "Booking safety rules:",
    "The booking prompt inside <booking_prompt> is the source of truth.",
    "Ask the booking prompt clearly now.",
    "Do not change the meaning of the booking prompt.",
    "Do not ask more than this one question.",
    "Do not summarize the caller's previous answer.",
    "Do not say the appointment is booked, scheduled, reserved, created, completed, or confirmed.",
    "Do not say the selected date, time, service, staff member, address, name, phone, price, policy, or appointment is locked in unless that exact information is already part of the booking prompt.",
    "Do not add extra booking details that are not inside the prompt.",
    "Do not call another tool before the caller answers.",
    "After asking the prompt, stop and wait for the caller answer.",
    "Do not mention internal tools, state, validation, or step names.",

    "",
    "<booking_prompt>",
    prompt,
    "</booking_prompt>",
  ]);
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
    return buildBookingStepPromptInstructions({
      prompt,
      activeLocale,
      mode: "next_step",
    });
  }

  if (params.toolResult?.ok === false && (retryPrompt || prompt)) {
    return buildBookingStepPromptInstructions({
      prompt: retryPrompt || prompt,
      activeLocale,
      mode: "retry_step",
    });
  }

  return "";
}