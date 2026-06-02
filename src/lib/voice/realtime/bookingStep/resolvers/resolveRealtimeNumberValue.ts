// src/lib/voice/realtime/bookingStep/resolvers/resolveRealtimeNumberValue.ts
import { clean } from "../../realtimeBookingFlowUtils";

function hasDigit(value: string): boolean {
  return /\d/.test(value);
}

function selectBestNumberCandidate(params: {
  value: string;
  rawTranscriptValue: string;
  modelValue: string;
}): {
  value: string;
  source: "model" | "value" | "transcript" | "none";
} {
  const value = clean(params.value);
  const rawTranscriptValue = clean(params.rawTranscriptValue);
  const modelValue = clean(params.modelValue);

  if (modelValue && hasDigit(modelValue)) {
    return {
      value: modelValue,
      source: "model",
    };
  }

  if (value && hasDigit(value)) {
    return {
      value,
      source: "value",
    };
  }

  if (rawTranscriptValue && hasDigit(rawTranscriptValue)) {
    return {
      value: rawTranscriptValue,
      source: "transcript",
    };
  }

  return {
    value: "",
    source: "none",
  };
}

export function resolveRealtimeNumberValue(params: {
  value: string;
  rawTranscriptValue: string;
  modelValue: string;
}) {
  const value = clean(params.value);
  const rawTranscriptValue = clean(params.rawTranscriptValue);
  const modelValue = clean(params.modelValue);

  if (!value && !rawTranscriptValue && !modelValue) {
    return {
      ok: false as const,
      error: "EMPTY_SUBMITTED_VALUE" as const,
      value: "" as const,
      rawTranscriptValue,
      modelValue,
      source: "none" as const,
    };
  }

  const selected = selectBestNumberCandidate({
    value,
    rawTranscriptValue,
    modelValue,
  });

  if (!selected.value) {
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
    value: selected.value,
    rawTranscriptValue,
    modelValue,
    source: selected.source,
  };
}