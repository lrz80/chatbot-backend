// src/lib/voice/realtime/bookingStep/resolvers/resolveRealtimeNumberValue.ts
import { clean } from "../../realtimeBookingFlowUtils";

function hasDigit(value: string): boolean {
  return /\d/.test(value);
}

export function resolveRealtimeNumberValue(params: {
  value: string;
  rawTranscriptValue: string;
  modelValue: string;
}) {
  const value = clean(params.value);
  const rawTranscriptValue = clean(params.rawTranscriptValue);
  const modelValue = clean(params.modelValue);

  if (!rawTranscriptValue) {
    return {
      ok: false as const,
      error: "EMPTY_SUBMITTED_VALUE" as const,
      value: "" as const,
      rawTranscriptValue,
      modelValue,
      source: "none" as const,
    };
  }

  if (!hasDigit(value)) {
    return {
      ok: false as const,
      error: "INCOMPATIBLE_NUMBER_VALUE" as const,
      value: "" as const,
      rawTranscriptValue,
      modelValue,
      source: "none" as const,
    };
  }

  return {
    ok: true as const,
    value,
    rawTranscriptValue,
    modelValue,
    source: "model" as const,
  };
}