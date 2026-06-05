//src/lib/voice/realtime/toolFollowup/resolveSyntheticSubmitBookingStepFollowup.ts
import { clean } from "../utils/clean";

type RealtimeToolLikeResult = {
  ok?: boolean;
  error?: string;
  next_required_step?: {
    step_key?: string;
    prompt?: string;
    retry_prompt?: string;
    prompt_translations?: Record<string, string>;
    retry_prompt_translations?: Record<string, string>;
  };
};

type ResolveSyntheticSubmitBookingStepFollowupParams = {
  toolName: string;
  toolResult: RealtimeToolLikeResult;
  currentLocale: string;
};

function selectPromptByLocale(params: {
  step: NonNullable<RealtimeToolLikeResult["next_required_step"]>;
  currentLocale: string;
  preferRetry: boolean;
}): string {
  const { step, currentLocale, preferRetry } = params;

  const locale = clean(currentLocale) || "en-US";

  if (preferRetry) {
    const translatedRetry = clean(step.retry_prompt_translations?.[locale]);
    if (translatedRetry) return translatedRetry;

    const retryPrompt = clean(step.retry_prompt);
    if (retryPrompt) return retryPrompt;
  }

  const translatedPrompt = clean(step.prompt_translations?.[locale]);
  if (translatedPrompt) return translatedPrompt;

  const prompt = clean(step.prompt);
  if (prompt) return prompt;

  const fallbackRetry = clean(step.retry_prompt_translations?.[locale]);
  if (fallbackRetry) return fallbackRetry;

  return clean(step.retry_prompt);
}

export function resolveSyntheticSubmitBookingStepFollowup(
  params: ResolveSyntheticSubmitBookingStepFollowupParams
): string {
  const { toolName, toolResult, currentLocale } = params;

  if (toolName !== "submit_booking_step") return "";

  const nextStep = toolResult?.next_required_step;
  if (!nextStep) return "";

  const nextPrompt = selectPromptByLocale({
    step: nextStep,
    currentLocale,
    preferRetry: toolResult.ok === false,
  });

  if (!nextPrompt) return "";

  return [
    "This is a live booking step prompt.",
    "Say only the configured booking prompt inside <booking_prompt> and </booking_prompt>.",
    "Do not add confirmations, summaries, explanations, transitions, or extra questions.",
    "Do not say or imply that the appointment is already booked, scheduled, reserved, confirmed, created, completed, set, or locked in unless that meaning is explicitly written inside the configured booking prompt.",
    "Do not mention any booking detail unless it is already written inside the configured booking prompt.",
    "Do not repeat, reinterpret, verify, correct, recalculate, or modify already collected booking details.",
    "Do not submit another booking step until the caller answers this current question.",
    "After saying the prompt, stop and wait for the caller answer.",
    "",
    "<booking_prompt>",
    nextPrompt,
    "</booking_prompt>",
  ].join("\n");
}