// src/lib/voice/realtime/i18n/buildI18nBookingFinalResponse.ts

import { clean } from "../utils/clean";

export function buildI18nBookingFinalResponse(params: {
  message: string;
  currentLocale: string;
  lastAssistantTranscript?: string;
  bookingLanguage?: string;
  bookingLockedLocale?: string | null;
  bookingLockedLanguageSample?: string | null;
}) {
  const message = clean(params.message);
  const currentLocale = clean(params.currentLocale);
  const lastAssistantTranscript = clean(params.lastAssistantTranscript || "");
  const bookingLanguage = clean(params.bookingLanguage || "");
  const bookingLockedLocale = clean(params.bookingLockedLocale || "");
  const bookingLockedLanguageSample = clean(
    params.bookingLockedLanguageSample || ""
  );

  const effectiveLanguageHint =
    bookingLockedLocale || bookingLanguage || currentLocale;

  return {
    conversation: "none",
    tool_choice: "none",
    instructions: [
      "You are rendering the final confirmation message after a live phone booking was successfully created.",
      "",
      "Booking language rule:",
      "- The booking language is still locked for this final confirmation message.",
      "- Use the natural language sample as the authority for the language.",
      "- If the weak language hint and the natural language sample disagree, follow the natural language sample.",
      "",
      `Natural language sample captured when booking started: "${
        bookingLockedLanguageSample || "unknown"
      }".`,
      `Weak language hint, not authoritative: ${
        effectiveLanguageHint || "unknown"
      }.`,
      `Previous assistant language sample: "${
        lastAssistantTranscript || "unknown"
      }".`,
      "",
      "Rendering task:",
      "- Translate the backend confirmation message naturally into the locked booking language.",
      "- Preserve the meaning that the appointment is confirmed.",
      "- Preserve the service and date/time meaning.",
      "- Then ask briefly if the caller needs anything else.",
      "- Do not mention tools, backend, calendar, slots, language rules, or internal logic.",
      "- Do not add new appointment details that are not present in the backend message.",
      "- Keep it concise and natural for phone speech.",
    ].join("\n"),
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              "Backend confirmation message meaning:",
              "",
              message,
              "",
              "Speak this naturally in the locked booking language.",
            ].join("\n"),
          },
        ],
      },
    ],
  };
}