// src/lib/i18n/languagePolicy.ts

import {
  DEFAULT_CANONICAL_LANG,
  normalizeLangCode,
  type LangCode,
} from "./lang";

export type AllowedLanguages = LangCode[] | "any";

export type LanguagePolicy = {
  canonicalLanguage: LangCode;
  supportedInputLanguages: AllowedLanguages;
  supportedOutputLanguages: AllowedLanguages;
  fallbackOutputLanguage: LangCode;
};

export const defaultLanguagePolicy: LanguagePolicy = {
  canonicalLanguage: DEFAULT_CANONICAL_LANG,
  supportedInputLanguages: "any",
  supportedOutputLanguages: "any",
  fallbackOutputLanguage: DEFAULT_CANONICAL_LANG,
};

export function normalizeAllowedLanguages(
  value: AllowedLanguages | undefined
): AllowedLanguages {
  if (!value || value === "any") return "any";

  const normalized = Array.from(
    new Set(
      value
        .map((item) => normalizeLangCode(item))
        .filter((item): item is LangCode => Boolean(item))
    )
  );

  return normalized.length > 0 ? normalized : "any";
}

export function isLanguageAllowed(
  code: string | null | undefined,
  allowed: AllowedLanguages
): boolean {
  const normalizedCode = normalizeLangCode(code);
  if (!normalizedCode) return false;
  if (allowed === "any") return true;
  return allowed.includes(normalizedCode);
}