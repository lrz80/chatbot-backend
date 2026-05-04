// src/lib/voice/resolveVoiceProviderVoice.ts

import { SupportedVoiceLocale } from "./resolveVoiceLanguage";

export function resolveVoiceProviderVoice(
  locale: SupportedVoiceLocale | string,
  cfgVoice?: string | null
): string {
  const normalizedLocale = (locale || "").toLowerCase();

  if (cfgVoice && cfgVoice !== "alice") {
    return cfgVoice;
  }

  if (normalizedLocale.startsWith("es")) {
    return "Polly.Mia";
  }

  if (normalizedLocale.startsWith("pt")) {
    return "Polly.Vitoria";
  }

  return "Polly.Joanna";
}