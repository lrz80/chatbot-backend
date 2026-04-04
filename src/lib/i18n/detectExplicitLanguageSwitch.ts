// src/lib/i18n/detectExplicitLanguageSwitch.ts

import { normalizeLangCode, type LangCode } from "./lang";

type LanguageAliasMap = Record<string, LangCode>;

const DEFAULT_LANGUAGE_ALIASES: LanguageAliasMap = {
  english: "en",
  ingles: "en",
  inglés: "en",
  spanish: "es",
  espanol: "es",
  español: "es",
  portuguese: "pt",
  portugues: "pt",
  portugués: "pt",
};

function normalizeText(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectExplicitLanguageSwitch(
  text: string,
  aliases: LanguageAliasMap = DEFAULT_LANGUAGE_ALIASES
): LangCode | null {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const entries = Object.entries(aliases);

  for (const [alias, langCode] of entries) {
    const normalizedAlias = normalizeText(alias);
    if (!normalizedAlias) continue;

    if (
      normalized.includes(`in ${normalizedAlias}`) ||
      normalized.includes(`en ${normalizedAlias}`) ||
      normalized.includes(`speak ${normalizedAlias}`) ||
      normalized.includes(`answer in ${normalizedAlias}`) ||
      normalized.includes(`respond in ${normalizedAlias}`) ||
      normalized.includes(`habla ${normalizedAlias}`) ||
      normalized.includes(`responde en ${normalizedAlias}`)
    ) {
      return normalizeLangCode(langCode);
    }
  }

  return null;
}