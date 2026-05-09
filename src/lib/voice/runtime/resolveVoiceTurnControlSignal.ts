// src/lib/voice/runtime/resolveVoiceTurnControlSignal.ts

import { resolveVoiceMetaSignal } from "../resolveVoiceMetaSignal";

export type VoiceTurnControlSignal =
  | {
      type: "language_switch";
      locale: "es-ES" | "en-US" | "pt-BR";
      confidence: number;
    }
  | {
      type: "none";
      confidence: number;
    };

type ResolveVoiceTurnControlSignalParams = {
  utterance: string;
  currentLocale: "es-ES" | "en-US" | "pt-BR";
};

function normalizeLocaleCandidate(
  value: string | null | undefined
): "es-ES" | "en-US" | "pt-BR" | null {
  if (!value) return null;

  const normalized = String(value).trim().toLowerCase();

  if (normalized === "es" || normalized === "es-es" || normalized === "spanish") {
    return "es-ES";
  }

  if (normalized === "en" || normalized === "en-us" || normalized === "english") {
    return "en-US";
  }

  if (normalized === "pt" || normalized === "pt-br" || normalized === "portuguese") {
    return "pt-BR";
  }

  return null;
}

export async function resolveVoiceTurnControlSignal({
  utterance,
  currentLocale,
}: ResolveVoiceTurnControlSignalParams): Promise<VoiceTurnControlSignal> {
  const text = String(utterance || "").trim();
  if (!text) {
    return { type: "none", confidence: 0 };
  }

  const meta = await resolveVoiceMetaSignal({
    utterance: text,
    locale: currentLocale,
  });

  const candidateLocale = normalizeLocaleCandidate(
    (meta as any)?.language ?? (meta as any)?.targetLanguage ?? null
  );

  const intent = String((meta as any)?.intent || "").trim().toLowerCase();
  const confidence = Number((meta as any)?.confidence || 0);

  if (
    intent === "language_switch" &&
    candidateLocale &&
    confidence >= 0.7
  ) {
    return {
      type: "language_switch",
      locale: candidateLocale,
      confidence,
    };
  }

  return { type: "none", confidence };
}