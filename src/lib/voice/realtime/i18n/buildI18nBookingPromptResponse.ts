//src/lib/voice/realtime/i18n/buildI18nBookingPromptResponse.ts

import { clean } from "../utils/clean";
import { buildExactRealtimeSpeechResponse } from "../buildExactRealtimeSpeechResponse";

export function buildI18nBookingPromptResponse(params: {
  prompt: string;
  currentLocale: string;
  lastAssistantTranscript?: string;
}) {
  const prompt = clean(params.prompt);
  const lastAssistantTranscript = clean(
    params.lastAssistantTranscript || ""
  );

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
      `Runtime locale: ${params.currentLocale}.`,
      `Previous assistant language sample: ${lastAssistantTranscript}.`,
      "Use the same language as the previous assistant language sample when it clearly shows the caller preferred language.",
      "If there is no clear previous language sample, use the runtime locale.",
      "Translate the configured booking question into the chosen language.",
      "Speak ONLY the translated booking question.",
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