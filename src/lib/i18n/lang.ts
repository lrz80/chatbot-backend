// src/lib/i18n/lang.ts

export type LangCode = string;

export const DEFAULT_CANONICAL_LANG = "es";

export function normalizeLangCode(code?: string | null): LangCode | null {
  const raw = String(code ?? "").trim().toLowerCase();
  if (!raw) return null;

  const normalized = raw.replace("_", "-");
  const separatorIndex = normalized.indexOf("-");
  const base =
    separatorIndex >= 0 ? normalized.slice(0, separatorIndex) : normalized;

  if (!base) return null;

  if (base.length === 2 && isAsciiLetters(base)) {
    return base;
  }

  return null;
}

export function toCanonicalLangOrFallback(
  code?: string | null,
  fallback: LangCode = DEFAULT_CANONICAL_LANG
): LangCode {
  return normalizeLangCode(code) ?? fallback;
}

export function isSameLang(a?: string | null, b?: string | null): boolean {
  const left = normalizeLangCode(a);
  const right = normalizeLangCode(b);

  return Boolean(left && right && left === right);
}

function isAsciiLetters(value: string): boolean {
  for (const char of value) {
    const charCode = char.charCodeAt(0);
    const isLowercaseLetter = charCode >= 97 && charCode <= 122;
    if (!isLowercaseLetter) return false;
  }
  return true;
}