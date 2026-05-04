// src/lib/voice/resolveVoiceTurnSignals.ts

export type VoiceTurnSignals = {
  normalizedText: string;
  extractedDigits: string;
};

export function normalizeText(value: string): string {
  return (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function extractDigits(value: string): string {
  return (value || "").replace(/\D+/g, "");
}

export function resolveVoiceTurnSignals(value: string): VoiceTurnSignals {
  return {
    normalizedText: normalizeText(value),
    extractedDigits: extractDigits(value),
  };
}