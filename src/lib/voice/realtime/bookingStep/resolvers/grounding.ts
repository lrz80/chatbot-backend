// src/lib/voice/realtime/bookingStep/resolvers/grounding.ts
import {
  clean,
  normalizeComparable,
} from "../../realtimeBookingFlowUtils";

export function tokenizeComparable(value: string): string[] {
  const normalized = normalizeComparable(value);

  return normalized
    .split(" ")
    .map((token) => clean(token))
    .filter(Boolean);
}

export function isModelValueGroundedInTranscript(params: {
  modelValue: string;
  rawTranscriptValue: string;
}): boolean {
  const modelValue = clean(params.modelValue);
  const rawTranscriptValue = clean(params.rawTranscriptValue);

  const normalizedModel = normalizeComparable(modelValue);
  const normalizedTranscript = normalizeComparable(rawTranscriptValue);

  if (!normalizedModel || !normalizedTranscript) {
    return false;
  }

  if (normalizedModel === normalizedTranscript) {
    return true;
  }

  const modelTokens = tokenizeComparable(modelValue);
  const transcriptTokens = new Set(tokenizeComparable(rawTranscriptValue));

  if (modelTokens.length === 0 || transcriptTokens.size === 0) {
    return false;
  }

  return modelTokens.every((token) => transcriptTokens.has(token));
}