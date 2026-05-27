// src/lib/voice/booking/services/getLocalizedBookingStepPrompt.ts

import type { VoiceLocale } from "../../types";
import type { BookingFlowStepLike } from "../../realtime/realtimeBookingFlowUtils";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export function getLocalizedBookingStepPrompt(params: {
  step: BookingFlowStepLike;
  locale: VoiceLocale;
  field: "prompt" | "retry_prompt";
}): string {
  const { step, locale, field } = params;

  const translationsField =
    field === "prompt" ? "prompt_translations" : "retry_prompt_translations";

  const translations = (step as any)?.[translationsField];

  if (
    translations &&
    typeof translations === "object" &&
    typeof translations[locale] === "string" &&
    translations[locale].trim()
  ) {
    return translations[locale].trim();
  }

  const directValue = clean((step as any)?.[field]);

  if (directValue) {
    return directValue;
  }

  return clean((step as any)?.prompt);
}