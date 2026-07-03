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
      "Ask the booking question now.",
      "Use the configured prompt as the meaning of the question.",
      "Translate or adapt that question naturally into the caller's active language.",
      "Say only the adapted question.",
      "Do not say you are checking, verifying, loading, confirming, or reviewing anything.",
      "Do not say 'one moment' or similar.",
      "Do not add explanations, summaries, confirmations, or extra details.",
      "",
      `Configured booking question: ${prompt}`,
    ].join("\n"),
    tool_choice: "none",
  };
}