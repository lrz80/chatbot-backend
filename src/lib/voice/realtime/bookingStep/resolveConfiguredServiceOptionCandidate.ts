//src/lib/voice/realtime/bookingStep/resolveConfiguredServiceOptionCandidate.ts
import type { BookingFlowStepLike } from "../realtimeBookingFlowUtils";

export type SubmitValueCandidate = {
  source: string;
  value: string;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeOptionText(value: unknown): string {
  return clean(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s&/+.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitOptionList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(clean).filter(Boolean);
  }

  const text = clean(value);
  if (!text) return [];

  return text
    .split(",")
    .map(clean)
    .filter(Boolean);
}

function collectOptionTexts(option: any): string[] {
  const texts = [
    clean(option?.label),
    clean(option?.name),
    clean(option?.value),
    clean(option?.canonical_value),
    clean(option?.canonicalValue),
    clean(option?.canonical),
    ...splitOptionList(option?.synonyms),
    ...splitOptionList(option?.aliases),
    ...splitOptionList(option?.speech_hints),
  ].filter(Boolean);

  return Array.from(new Set(texts));
}

function getOptionCanonicalValue(option: any): string {
  return (
    clean(option?.canonical_value) ||
    clean(option?.canonicalValue) ||
    clean(option?.value) ||
    clean(option?.name) ||
    clean(option?.label)
  );
}

function getStepValidationOptions(step: BookingFlowStepLike | null): any[] {
  const rawOptions = (step as any)?.validation_config?.options;

  if (!Array.isArray(rawOptions)) return [];

  return rawOptions.filter(Boolean);
}

export function resolveConfiguredServiceOptionCandidate(params: {
  currentStep: BookingFlowStepLike | null;
  values: string[];
}): SubmitValueCandidate | null {
  const options = getStepValidationOptions(params.currentStep);
  if (!options.length) return null;

  const normalizedValues = params.values
    .map(normalizeOptionText)
    .filter(Boolean);

  if (!normalizedValues.length) return null;

  const matches = options
    .map((option) => {
      const canonicalValue = getOptionCanonicalValue(option);
      if (!canonicalValue) return null;

      const normalizedOptionTexts = collectOptionTexts(option)
        .map(normalizeOptionText)
        .filter(Boolean);

      const matched = normalizedValues.some((submittedValue) =>
        normalizedOptionTexts.some((optionText) => optionText === submittedValue)
      );

      if (!matched) return null;

      return canonicalValue;
    })
    .filter(Boolean) as string[];

  const uniqueMatches = Array.from(new Set(matches));

  if (uniqueMatches.length !== 1) return null;

  return {
    source: "configured_option",
    value: uniqueMatches[0],
  };
}