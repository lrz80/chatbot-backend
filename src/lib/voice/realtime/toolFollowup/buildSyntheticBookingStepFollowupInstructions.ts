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
      ? "The caller answer was not valid for the current booking step."
      : "The backend accepted the previous booking step and selected the next required booking step.";

  return joinInstructions([
    "You are in a live phone booking flow.",
    flowContext,
    activeLocale
      ? `Respond in the active call language: ${activeLocale}.`
      : "",

    "",
    "Strict output rule:",
    "Say only the configured booking prompt.",
    "Do not add any transition, confirmation, explanation, status update, filler phrase, or extra words.",
    "Do not mention internal processing, tools, validation, availability checks, calendar checks, or step names.",
    "Do not say anything before the prompt.",
    "Do not say anything after the prompt.",
    "After saying the prompt, stop and wait for the caller answer.",

    "",
    "Configured booking prompt:",
    prompt,
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