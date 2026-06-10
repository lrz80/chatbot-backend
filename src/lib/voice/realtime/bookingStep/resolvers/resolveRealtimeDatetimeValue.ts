// src/lib/voice/realtime/bookingStep/resolvers/resolveRealtimeDatetimeValue.ts
import {
  hasExplicitVoiceDateAnchor,
  parseVoiceRequestedDate,
} from "../../../../appointments/parseVoiceRequestedDate";
import { clean } from "../../realtimeBookingFlowUtils";
import { isModelValueGroundedInTranscript } from "./grounding";

export type ResolveRealtimeDatetimeValueResult =
  | {
      ok: true;
      value: string;
      rawTranscriptValue: string;
      modelValue: string;
      source: "model" | "transcript";
    }
  | {
      ok: false;
      error: "INCOMPATIBLE_DATETIME_VALUE";
      value: "";
      rawTranscriptValue: string;
      modelValue: string;
      source: "none";
    };

function isCompleteParsableDatetime(params: {
  value: string;
  timeZone: string;
}): boolean {
  const value = clean(params.value);
  const timeZone = clean(params.timeZone);

  if (!value || !timeZone) {
    return false;
  }

  const parsed = parseVoiceRequestedDate({
    raw: value,
    timeZone,
  });

  return parsed.ok === true;
}

export function resolveRealtimeDatetimeValue(params: {
  value: string;
  rawTranscriptValue: string;
  modelValue: string;
  timeZone: string;
}): ResolveRealtimeDatetimeValueResult {
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

  const transcriptValueIsCompleteDatetime = isCompleteParsableDatetime({
    value: rawTranscriptValue,
    timeZone,
  });

  if (!transcriptValueHasDateAnchor || !transcriptValueIsCompleteDatetime) {
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

  const modelValueIsCompleteDatetime = isCompleteParsableDatetime({
    value,
    timeZone,
  });

  if (
    modelValueHasDateAnchor &&
    modelValueIsCompleteDatetime &&
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