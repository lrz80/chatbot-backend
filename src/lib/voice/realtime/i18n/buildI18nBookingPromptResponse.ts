// src/lib/voice/realtime/i18n/buildI18nBookingPromptResponse.ts

import { clean } from "../utils/clean";
import { buildExactRealtimeSpeechResponse } from "../buildExactRealtimeSpeechResponse";
import { buildVoiceSpeechIdentity } from "../voiceSpeechIdentity";

function requiresFaithfulTranslation(stepKey: string): boolean {
  const normalizedStepKey = clean(stepKey).toLowerCase();

  return (
    normalizedStepKey === "confirm" ||
    normalizedStepKey === "phone" ||
    normalizedStepKey === "offer_booking_sms"
  );
}

export function buildI18nBookingPromptResponse(params: {
  stepKey: string;
  prompt: string;
  currentLocale: string;
  lastAssistantTranscript?: string;
  bookingLanguage?: string;
  bookingLockedLocale?: string | null;
  bookingLockedLanguageSample?: string | null;
}) {
  const stepKey = clean(params.stepKey);
  const prompt = clean(params.prompt);
  const currentLocale = clean(params.currentLocale);
  const lastAssistantTranscript = clean(
    params.lastAssistantTranscript || ""
  );
  const bookingLanguage = clean(params.bookingLanguage || "");
  const bookingLockedLocale = clean(params.bookingLockedLocale || "");
  const bookingLockedLanguageSample = clean(
    params.bookingLockedLanguageSample || ""
  );

  const effectiveLockedLanguage =
    bookingLockedLocale ||
    bookingLanguage ||
    currentLocale;

  /**
   * Legacy fallback:
   * When multilingual prompt rendering is disabled, preserve
   * the previous exact-text production behavior.
   */
  if (process.env.VOICE_BOOKING_I18N_PROMPTS_ENABLED !== "true") {
    return buildExactRealtimeSpeechResponse({
      prompt,
      currentLocale: effectiveLockedLanguage || currentLocale,
    });
  }

  /**
   * Deterministic multilingual steps:
   *
   * These prompts may be translated into the locked booking language,
   * but their content, structure and appointment details must not be
   * rewritten or paraphrased.
   */
  if (requiresFaithfulTranslation(stepKey)) {
    return {
      conversation: "none",
      tool_choice: "none",

      metadata: {
        purpose: "faithful_booking_prompt_translation",
        step_key: stepKey,
        expected_prompt: prompt,
        locale: effectiveLockedLanguage,
      },

      instructions: [
        buildVoiceSpeechIdentity({
          activeLanguage: effectiveLockedLanguage,
        }),

        "",
        "BOOKING LANGUAGE LOCK:",
        "- The booking flow language is locked until the booking flow ends.",
        "- Speak in the locked booking language.",
        "- Do not switch language because of the caller's latest short response.",
        "- Do not use the tenant default language unless it matches the locked booking language.",

        "",
        `Locked booking language hint: ${
          effectiveLockedLanguage || "unknown"
        }.`,
        `Natural language sample captured when booking started: "${
          bookingLockedLanguageSample || "unknown"
        }".`,
        `Previous assistant language sample: "${
          lastAssistantTranscript || "unknown"
        }".`,
        `Runtime locale: ${currentLocale || "unknown"}.`,

        "",
        "FAITHFUL PROMPT RENDERING TASK:",
        "- Speak the configured booking prompt in the locked booking language.",
        "- If the prompt is already in the locked booking language, speak it exactly as written.",
        "- If the prompt is in another language, translate it faithfully into the locked booking language.",
        "- Translate only when necessary.",
        "- Do not rewrite, paraphrase, summarize, simplify, expand, improve, or reinterpret the prompt.",
        "- Preserve the original sentence order, meaning, clauses, conditions, and question structure.",
        "- Preserve every customer name, service name, staff name, phone number, address, date, time, price, duration, policy, and appointment detail.",
        "- Preserve whether the configured prompt is a question, statement, or confirmation request.",
        "- Do not say the appointment is confirmed unless the configured prompt says it is confirmed.",
        "- Do not change a confirmation request into a completed confirmation.",
        "- Do not omit any part of the configured prompt.",
        "- Do not add greetings, acknowledgements, transitions, filler, explanations, or additional questions.",
        "- Return only the spoken prompt.",
      ].join("\n"),

      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "Render the configured booking prompt below.",
                "Translate it only if necessary to match the locked booking language.",
                "Preserve its content and structure.",
                "Return only the spoken result.",
                "",
                "Configured booking prompt:",
                prompt,
              ].join("\n"),
            },
          ],
        },
      ],
    };
  }

  /**
   * Flexible multilingual steps:
   *
   * Steps such as service, staff and datetime may be rendered
   * naturally while preserving the intended question.
   */
  return {
    conversation: "none",
    tool_choice: "none",

    metadata: {
      purpose: "natural_i18n_booking_prompt",
      step_key: stepKey,
      expected_prompt: prompt,
      locale: effectiveLockedLanguage,
    },

    instructions: [
      buildVoiceSpeechIdentity({
        activeLanguage: effectiveLockedLanguage,
      }),

      "",
      "BOOKING LANGUAGE LOCK:",
      "- The booking flow language is locked until the booking flow ends.",
      "- Use the locked booking language for every booking question, retry, unavailable message, confirmation, and booking follow-up.",
      "- Do not switch language during the booking flow even if the caller speaks another language.",
      "- If the stored booking prompt is written in another language, translate it naturally into the locked booking language before speaking.",
      "- Do not read the stored booking prompt literally if it is not in the locked booking language.",
      "- Do not use English just because the stored booking prompt is in English.",
      "- Do not use the tenant default language unless it matches the locked booking language.",

      "",
      `Natural language sample captured when booking started: "${
        bookingLockedLanguageSample || "unknown"
      }".`,
      `Weak language hint, not authoritative: ${
        effectiveLockedLanguage || "unknown"
      }.`,
      "Use the natural language sample as the authority for the booking language.",
      "The previous assistant message inside the natural language sample is the strongest signal.",
      "If the weak language hint and the natural language sample disagree, ignore the hint and follow the sample.",
      "Do not switch to Spanish only because the runtime detector classified the latest short utterance as Spanish.",
      `Runtime locale: ${currentLocale || "unknown"}.`,
      `Previous assistant language sample: "${
        lastAssistantTranscript || "unknown"
      }".`,

      "",
      "NATURAL PROMPT RENDERING TASK:",
      "- Treat the configured booking prompt as semantic meaning, not as exact text to read.",
      "- Speak only the next booking question in the locked booking language.",
      "- Ask one question only.",
      "- Do not answer the question.",
      "- Do not say one moment.",
      "- Do not say you are checking, verifying, confirming, loading, reviewing, or processing anything.",
      "- Do not add greetings.",
      "- Do not add explanations.",
      "- Do not mention tools, slots, step keys, translations, language rules, or internal booking flow logic.",
      "- Do not add an additional booking question.",
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