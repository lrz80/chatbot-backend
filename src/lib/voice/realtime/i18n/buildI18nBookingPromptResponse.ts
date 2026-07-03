//src/lib/voice/realtime/i18n/buildI18nBookingPromptResponse.ts

import { clean } from "../utils/clean";
import { buildExactRealtimeSpeechResponse } from "../buildExactRealtimeSpeechResponse";

export function buildI18nBookingPromptResponse(params: {
  prompt: string;
  currentLocale: string;
}) {
  const prompt = clean(params.prompt);

  if (process.env.VOICE_BOOKING_I18N_PROMPTS_ENABLED !== "true") {
    return buildExactRealtimeSpeechResponse({
      prompt,
      currentLocale: params.currentLocale as any,
    });
  }

  return {
    instructions: [
      `Caller active locale: ${params.currentLocale}.`,
      "Ask the next booking question using the caller's current language.",
      "Use the configured prompt only as semantic meaning, not as exact text to read.",
      "If the configured prompt is in a different language, adapt it naturally.",
      "Ask only one short question.",
      "Do not add explanations, summaries, confirmations, or extra details.",
      "",
      `Configured prompt meaning: ${prompt}`,
    ].join("\n"),
    tool_choice: "none",
  };
}