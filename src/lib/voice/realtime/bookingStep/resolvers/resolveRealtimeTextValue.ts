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

  /**
   * Only enable this for provider-backed service resolution.
   *
   * Service names often need ASR cleanup or language normalization before
   * matching against Square/dashboard catalog.
   *
   * Do NOT enable for name, phone, email, confirmation, datetime, or generic text.
   */
  allowModelNormalization?: boolean;
}): ResolveRealtimeTextValueResult {
  const value = clean(params.value);
  const rawTranscriptValue = clean(params.rawTranscriptValue);
  const modelValue = clean(params.modelValue);
  const allowModelNormalization = params.allowModelNormalization === true;

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

    if (!grounded && !allowModelNormalization) {
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
      source: value === rawTranscriptValue ? "transcript" : "model",
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