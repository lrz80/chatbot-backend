// src/lib/i18n/resolveTurnLanguage.ts

import { normalizeLangCode, type LangCode } from "./lang";
import {
  defaultLanguagePolicy,
  isLanguageAllowed,
  type LanguagePolicy,
} from "./languagePolicy";

export type ResolveTurnLanguageInput = {
  detectedLang?: string | null;
  storedLang?: string | null;
  forcedLang?: string | null;
  threadLang?: string | null;
  tenantBase?: string | null;
  policy?: LanguagePolicy;
};

export type ResolveTurnLanguageResult = {
  inputLang: LangCode | null;
  canonicalLang: LangCode;
  outputLang: LangCode;
  needsInputTranslation: boolean;
  needsOutputTranslation: boolean;
  isInputSupported: boolean;
};

export function resolveTurnLanguage(
  input: ResolveTurnLanguageInput
): ResolveTurnLanguageResult {
  const policy = input.policy ?? defaultLanguagePolicy;

  const forcedLang = normalizeLangCode(input.forcedLang);
  const detectedLang = normalizeLangCode(input.detectedLang);
  const threadLang = normalizeLangCode(input.threadLang);
  const storedLang = normalizeLangCode(input.storedLang);
  const tenantBase =
    normalizeLangCode(input.tenantBase) ?? policy.fallbackOutputLanguage;

  const inputLang =
    forcedLang ??
    detectedLang ??
    threadLang ??
    storedLang ??
    tenantBase;

  const isInputSupported = isLanguageAllowed(
    inputLang,
    policy.supportedInputLanguages
  );

  const candidateOutputLang = inputLang ?? policy.fallbackOutputLanguage;

  const outputLang =
    isInputSupported &&
    isLanguageAllowed(candidateOutputLang, policy.supportedOutputLanguages)
      ? candidateOutputLang
      : policy.fallbackOutputLanguage;

  const canonicalLang = policy.canonicalLanguage;

  return {
    inputLang,
    canonicalLang,
    outputLang,
    needsInputTranslation: Boolean(inputLang && inputLang !== canonicalLang),
    needsOutputTranslation: outputLang !== canonicalLang,
    isInputSupported,
  };
}