//src/lib/voice/voiceMenuCopy.ts
import { SupportedVoiceLocale } from "./resolveVoiceLanguage";

export type VoiceMenuCopy = {
  englishIntroPrompt: string;
  spanishSelectionPrompt: string;
  spanishConfirmedPrompt: string;
};

const VOICE_MENU_COPY: Record<SupportedVoiceLocale, VoiceMenuCopy> = {
  "es-ES": {
    englishIntroPrompt: "Hello.",
    spanishSelectionPrompt: 'Para español, marque dos o diga "Español".',
    spanishConfirmedPrompt: "Continuamos en español.",
  },
  "en-US": {
    englishIntroPrompt: "Hello.",
    spanishSelectionPrompt: 'Para español, marque dos o diga "Español".',
    spanishConfirmedPrompt: "Continuamos en español.",
  },
  "pt-BR": {
    englishIntroPrompt: "Hello.",
    spanishSelectionPrompt: 'Para español, marque dos o diga "Español".',
    spanishConfirmedPrompt: "Continuamos en español.",
  },
};

export function getVoiceMenuCopy(
  locale: SupportedVoiceLocale | string | undefined
): VoiceMenuCopy {
  if (locale === "es-ES" || locale === "en-US" || locale === "pt-BR") {
    return VOICE_MENU_COPY[locale];
  }

  return VOICE_MENU_COPY["en-US"];
}