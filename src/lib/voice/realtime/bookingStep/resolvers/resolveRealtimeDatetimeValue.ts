// src/lib/voice/realtime/bookingStep/resolvers/resolveRealtimeDatetimeValue.ts
import { hasExplicitVoiceDateAnchor } from "../../../../appointments/parseVoiceRequestedDate";
import { clean } from "../../realtimeBookingFlowUtils";
import { isModelValueGroundedInTranscript } from "./grounding";

export function resolveRealtimeDatetimeValue(params: {
  value: string;
  rawTranscriptValue: string;
  modelValue: string;
  timeZone: string;
}) {
  const value = clean(params.value);
  const rawTranscriptValue = clean(params.rawTranscriptValue);
  const modelValue = clean(params.modelValue);
  const timeZone = clean(params.timeZone);

  const transcriptValueHasDateAnchor =
    Boolean(rawTranscriptValue) &&
    hasExplicitVoiceDateAnchor({
      raw: rawTranscriptValue,
      timeZone,
    });

  if (!transcriptValueHasDateAnchor) {
    return {
      ok: false as const,
      error: "INCOMPATIBLE_DATETIME_VALUE" as const,
      value: "" as const,
      rawTranscriptValue,
      modelValue,
      source: "none" as const,
    };
  }

  const modelValueHasDateAnchor =
    Boolean(value) &&
    hasExplicitVoiceDateAnchor({
      raw: value,
      timeZone,
    });

  if (
    modelValueHasDateAnchor &&
    isModelValueGroundedInTranscript({
      modelValue: value,
      rawTranscriptValue,
    })
  ) {
    return {
      ok: true as const,
      value,
      rawTranscriptValue,
      modelValue,
      source: "model" as const,
    };
  }

  return {
    ok: true as const,
    value: rawTranscriptValue,
    rawTranscriptValue,
    modelValue,
    source: "transcript" as const,
  };
}