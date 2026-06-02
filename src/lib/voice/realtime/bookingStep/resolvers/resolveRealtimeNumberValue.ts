// src/lib/voice/realtime/bookingStep/resolvers/resolveRealtimeNumberValue.ts
import { clean } from "../../realtimeBookingFlowUtils";

type NumberValueSource = "model" | "transcript";

type NumberCandidateSelection =
  | {
      ok: true;
      value: string;
      source: NumberValueSource;
    }
  | {
      ok: false;
      value: "";
      source: "none";
    };

function hasDigit(value: string): boolean {
  return /\d/.test(value);
}

function selectBestNumberCandidate(params: {
  value: string;
  rawTranscriptValue: string;
  modelValue: string;
}): NumberCandidateSelection {
  const value = clean(params.value);
  const rawTranscriptValue = clean(params.rawTranscriptValue);
  const modelValue = clean(params.modelValue);

  if (modelValue && hasDigit(modelValue)) {
    return {
      ok: true,
      value: modelValue,
      source: "model",
    };
  }

  if (value && hasDigit(value)) {
    return {
      ok: true,
      value,
      source: modelValue && value === modelValue ? "model" : "transcript",
    };
  }

  if (rawTranscriptValue && hasDigit(rawTranscriptValue)) {
    return {
      ok: true,
      value: rawTranscriptValue,
      source: "transcript",
    };
  }

  return {
    ok: false,
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

  if (!selected.ok) {
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