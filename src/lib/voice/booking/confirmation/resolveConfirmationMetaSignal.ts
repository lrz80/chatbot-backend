//src/lib/voice/booking/confirmation/resolveConfirmationMetaSignal.ts
import { resolveVoiceMetaSignal } from "../../resolveVoiceMetaSignal";
import type { VoiceLocale } from "../../types";

export type ConfirmationMetaSignal = {
  intent: "affirm" | "reject" | "none";
  confidence?: number;
};

export async function resolveConfirmationMetaSignal(params: {
  digits: string;
  userInput: string;
  currentLocale: VoiceLocale;
}): Promise<ConfirmationMetaSignal> {
  const { digits, userInput, currentLocale } = params;

  if (digits === "1") {
    return { intent: "affirm", confidence: 1 };
  }

  if (digits === "2") {
    return { intent: "reject", confidence: 1 };
  }

  const resolved = await resolveVoiceMetaSignal({
    utterance: userInput,
    locale: currentLocale,
  });

  if (resolved.intent === "affirm") {
    return {
      intent: "affirm",
      confidence: resolved.confidence,
    };
  }

  if (resolved.intent === "reject") {
    return {
      intent: "reject",
      confidence: resolved.confidence,
    };
  }

  return {
    intent: "none",
    confidence: resolved.confidence,
  };
}