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
    conversation: "none",
    tool_choice: "none",
    instructions: [
      "You are a speech renderer for a live booking flow.",
      `Target language/locale: ${params.currentLocale}.`,
      "Translate the configured booking question into the target language.",
      "Speak ONLY the translated question.",
      "Do not answer the question.",
      "Do not say one moment.",
      "Do not say you are checking, verifying, confirming, loading, reviewing, or processing anything.",
      "Do not add greetings.",
      "Do not add explanations.",
      "Do not add extra words.",
    ].join("\n"),
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              "Translate and speak only this booking question:",
              "",
              prompt,
            ].join("\n"),
          },
        ],
      },
    ],
  };
}