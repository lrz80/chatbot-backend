// src/lib/voice/realtime/bookingStep/resolvers/resolveRealtimeTextValue.ts
import { clean } from "../../realtimeBookingFlowUtils";
import { isModelValueGroundedInTranscript } from "./grounding";

export type ResolveRealtimeTextValueResult =
  | {
      ok: true;
      value: string;
      rawTranscriptValue: string;
      modelValue: string;
      source: "model" | "transcript";
    }
  | {
      ok: false;
      error: "EMPTY_SUBMITTED_VALUE" | "INCOMPATIBLE_TEXT_VALUE";
      value: "";
      rawTranscriptValue: string;
      modelValue: string;
      source: "none";
    };

export function resolveRealtimeTextValue(params: {
  value: string;
  rawTranscriptValue: string;
  modelValue: string;
}): ResolveRealtimeTextValueResult {
  const value = clean(params.value);
  const rawTranscriptValue = clean(params.rawTranscriptValue);
  const modelValue = clean(params.modelValue);

  if (!value && !rawTranscriptValue) {
    return {
      ok: false,
      error: "EMPTY_SUBMITTED_VALUE",
      value: "",
      rawTranscriptValue,
      modelValue,
      source: "none",
    };
  }

  if (value) {
    const grounded = isModelValueGroundedInTranscript({
      modelValue: value,
      rawTranscriptValue,
    });

    if (!grounded) {
      return {
        ok: false,
        error: "INCOMPATIBLE_TEXT_VALUE",
        value: "",
        rawTranscriptValue,
        modelValue,
        source: "none",
      };
    }

    return {
      ok: true,
      value,
      rawTranscriptValue,
      modelValue,
      source: "model",
    };
  }

  if (rawTranscriptValue) {
    return {
      ok: true,
      value: rawTranscriptValue,
      rawTranscriptValue,
      modelValue,
      source: "transcript",
    };
  }

  return {
    ok: false,
    error: "INCOMPATIBLE_TEXT_VALUE",
    value: "",
    rawTranscriptValue,
    modelValue,
    source: "none",
  };
}