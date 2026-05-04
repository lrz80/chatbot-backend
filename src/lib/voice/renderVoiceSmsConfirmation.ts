// src/lib/voice/renderVoiceSmsConfirmation.ts

import { SupportedVoiceLocale } from "./resolveVoiceLanguage";

function isSpanish(locale: SupportedVoiceLocale | string): boolean {
  return (locale || "").toLowerCase().startsWith("es");
}

function isPortuguese(locale: SupportedVoiceLocale | string): boolean {
  return (locale || "").toLowerCase().startsWith("pt");
}

export function renderVoiceSmsConfirmation(
  locale: SupportedVoiceLocale | string,
  maskedDestination: string
): string {
  if (isSpanish(locale)) {
    return `Te lo envío al ${maskedDestination}. Di "sí" o pulsa 1 para confirmar, o dicta otro número.`;
  }

  if (isPortuguese(locale)) {
    return `Vou enviar para ${maskedDestination}. Diga "sim" ou pressione 1 para confirmar, ou diga outro número.`;
  }

  return `I'll text ${maskedDestination}. Say "yes" or press 1 to confirm, or say another number.`;
}