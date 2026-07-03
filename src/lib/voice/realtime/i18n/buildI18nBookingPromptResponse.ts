// src/lib/voice/realtime/i18n/buildI18nBookingPromptResponse.ts

import { clean } from "../utils/clean";
import { buildExactRealtimeSpeechResponse } from "../buildExactRealtimeSpeechResponse";

export function buildI18nBookingPromptResponse(params: {
  prompt: string;
  currentLocale: string;
  lastAssistantTranscript?: string;
  bookingLanguage?: string;
  bookingLockedLocale?: string | null;
  bookingLockedLanguageSample?: string | null;
}) {
  const prompt = clean(params.prompt);
  const currentLocale = clean(params.currentLocale);
  const lastAssistantTranscript = clean(params.lastAssistantTranscript || "");
  const bookingLanguage = clean(params.bookingLanguage || "");
  const bookingLockedLocale = clean(params.bookingLockedLocale || "");
  const bookingLockedLanguageSample = clean(
    params.bookingLockedLanguageSample || ""
  );

  const effectiveLockedLanguage =
    bookingLockedLocale || bookingLanguage || currentLocale;

  /**
   * Legacy fallback:
   * When i18n prompt rendering is disabled, keep the old exact speech behavior.
   * This preserves current production behavior for environments where
   * VOICE_BOOKING_I18N_PROMPTS_ENABLED is not explicitly enabled.
   */
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
      "You are a speech renderer for a live phone booking flow.",
      "",
      "Booking language lock rule:",
      "- The booking flow language is locked until the booking flow ends.",
      "- Use the locked booking language for every booking question, retry, unavailable message, confirmation, and booking follow-up.",
      "- Do not switch language during the booking flow even if the caller speaks another language.",
      "- If the stored booking prompt is written in another language, translate it naturally into the locked booking language before speaking.",
      "- Do not read the stored booking prompt literally if it is not in the locked booking language.",
      "- Do not use English just because the stored booking prompt is in English.",
      "- Do not use the tenant default language unless it matches the locked booking language.",
      "",
      `Locked booking locale: ${effectiveLockedLanguage || "unknown"}.`,
      `Caller message used when the booking language was locked: "${
        bookingLockedLanguageSample || "unknown"
      }".`,
      `Runtime locale: ${currentLocale || "unknown"}.`,
      `Previous assistant language sample: "${
        lastAssistantTranscript || "unknown"
      }".`,
      "",
      "Rendering task:",
      "- Treat the configured booking prompt as semantic meaning, not as exact text to read.",
      "- Speak only the next booking question in the locked booking language.",
      "- Ask one question only.",
      "- Do not answer the question.",
      "- Do not say one moment.",
      "- Do not say you are checking, verifying, confirming, loading, reviewing, or processing anything.",
      "- Do not add greetings.",
      "- Do not add explanations.",
      "- Do not mention tools, slots, step keys, translations, language rules, or internal booking flow logic.",
      "- Do not add extra words.",
    ].join("\n"),
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              "Configured booking prompt meaning:",
              "",
              prompt,
              "",
              "Speak only the next booking question in the locked booking language.",
            ].join("\n"),
          },
        ],
      },
    ],
  };
}