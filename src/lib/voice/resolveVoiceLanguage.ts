// src/lib/voice/resolveVoiceLanguage.ts

export type SupportedVoiceLocale = "es-ES" | "en-US" | "pt-BR";
export type SupportedVoiceLanguage = "es" | "en" | "pt";

type ResolveLanguageSelectionInput = {
  digits?: string | null;
  speech?: string | null;
};

type ResolveLanguageSelectionResult = {
  selectedLanguage: SupportedVoiceLanguage;
  explicitLanguageSelection: boolean;
  hasRealUtterance: boolean;
  normalizedSpeech: string;
  originalSpeech: string;
};

const DEFAULT_VOICE_LANGUAGE: SupportedVoiceLanguage = "en";

export function normalizeVoiceLanguageTag(
  value?: string | null
): SupportedVoiceLanguage | null {
  const v = (value || "").trim().toLowerCase();

  if (!v) {
    return null;
  }

  if (v === "es" || v.startsWith("es-")) {
    return "es";
  }

  if (v === "en" || v.startsWith("en-")) {
    return "en";
  }

  if (v === "pt" || v.startsWith("pt-")) {
    return "pt";
  }

  return null;
}

export function toVoiceLocale(
  value?: string | null,
  fallback: SupportedVoiceLocale = "en-US"
): SupportedVoiceLocale {
  const lang = normalizeVoiceLanguageTag(value);

  if (lang === "es") {
    return "es-ES";
  }

  if (lang === "pt") {
    return "pt-BR";
  }

  if (lang === "en") {
    return "en-US";
  }

  return fallback;
}

export function normalizeVoiceSpeech(value?: string | null): string {
  return (value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isExplicitSpanishSelection(
  digits?: string | null,
  speech?: string | null
): boolean {
  const normalizedSpeech = normalizeVoiceSpeech(speech);
  const normalizedDigits = (digits || "").trim();

  if (normalizedDigits === "2") {
    return true;
  }

  return /\b(spanish|espanol|español|castellano|dos|2)\b/i.test(
    normalizedSpeech
  );
}

export function resolveVoiceLanguageSelection(
  input: ResolveLanguageSelectionInput
): ResolveLanguageSelectionResult {
  const originalSpeech = (input.speech || "").trim();
  const normalizedSpeech = normalizeVoiceSpeech(input.speech);
  const explicitSpanish = isExplicitSpanishSelection(input.digits, input.speech);

  const selectedLanguage: SupportedVoiceLanguage = explicitSpanish
    ? "es"
    : DEFAULT_VOICE_LANGUAGE;

  const hasRealUtterance =
    !!originalSpeech &&
    !explicitSpanish &&
    (input.digits || "").trim() !== "2";

  return {
    selectedLanguage,
    explicitLanguageSelection: explicitSpanish,
    hasRealUtterance,
    normalizedSpeech,
    originalSpeech,
  };
}

export function resolveLocaleFromQueryLang(
  queryLang?: string | null,
  fallback: SupportedVoiceLocale = "en-US"
): SupportedVoiceLocale {
  if (!queryLang) {
    return fallback;
  }

  return toVoiceLocale(queryLang, fallback);
}

export function resolveEffectiveVoiceLocale(input: {
  persistedLang?: string | null;
  queryLang?: string | null;
  fallback?: SupportedVoiceLocale;
}): SupportedVoiceLocale {
  const fallback = input.fallback || "en-US";

  const fromPersisted = toVoiceLocale(input.persistedLang, fallback);
  const normalizedQuery = normalizeVoiceLanguageTag(input.queryLang);

  if (normalizedQuery) {
    return toVoiceLocale(normalizedQuery, fromPersisted);
  }

  return fromPersisted;
}