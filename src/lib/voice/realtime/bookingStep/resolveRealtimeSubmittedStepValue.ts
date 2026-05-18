// src/lib/voice/realtime/bookingStep/resolveRealtimeSubmittedStepValue.ts
import { hasExplicitVoiceDateAnchor } from "../../../appointments/parseVoiceRequestedDate";
import {
  clean,
  normalizeComparable,
  type BookingFlowStepLike,
} from "../realtimeBookingFlowUtils";

export type RealtimeSubmittedStepValueResult =
  | {
      ok: true;
      value: string;
      rawTranscriptValue: string;
      modelValue: string;
      source: "model" | "transcript";
    }
  | {
      ok: false;
      error:
        | "EMPTY_SUBMITTED_VALUE"
        | "INCOMPATIBLE_NUMBER_TRANSCRIPT"
        | "INCOMPATIBLE_DATETIME_VALUE";
      value: "";
      rawTranscriptValue: string;
      modelValue: string;
      source: "none";
    };

function getValidationSlot(step: BookingFlowStepLike): string {
  return typeof step.validation_config?.slot === "string"
    ? clean(step.validation_config.slot)
    : "";
}

function resolveExpectedType(step: BookingFlowStepLike): string {
  return clean(step.expected_type || "");
}

function isDatetimeStep(step: BookingFlowStepLike): boolean {
  const stepKey = clean(step.step_key);
  const slot = getValidationSlot(step);

  return stepKey === "datetime" || slot === "datetime";
}

function isNumberLike(value: string): boolean {
  const normalized = normalizeComparable(value);

  if (!normalized) {
    return false;
  }

  if (/\d/.test(normalized)) {
    return true;
  }

  const numberWords = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "twenty",
    "thirty",
    "forty",
    "fifty",
    "hundred",
    "cero",
    "uno",
    "una",
    "dos",
    "tres",
    "cuatro",
    "cinco",
    "seis",
    "siete",
    "ocho",
    "nueve",
    "diez",
    "once",
    "doce",
    "veinte",
    "treinta",
    "cuarenta",
    "cincuenta",
    "cien",
  ];

  return numberWords.some((word) => normalized.includes(word));
}

function resolveDatetimeValue(params: {
  value: string;
  rawTranscriptValue: string;
  timeZone: string;
}): RealtimeSubmittedStepValueResult {
  const { value, rawTranscriptValue, timeZone } = params;

  const modelValueHasDateAnchor =
    Boolean(value) &&
    hasExplicitVoiceDateAnchor({
      raw: value,
      timeZone,
    });

  const transcriptValueHasDateAnchor =
    Boolean(rawTranscriptValue) &&
    hasExplicitVoiceDateAnchor({
      raw: rawTranscriptValue,
      timeZone,
    });

  if (modelValueHasDateAnchor) {
    return {
      ok: true,
      value,
      rawTranscriptValue,
      modelValue: value,
      source: "model",
    };
  }

  if (transcriptValueHasDateAnchor) {
    return {
      ok: true,
      value: rawTranscriptValue,
      rawTranscriptValue,
      modelValue: value,
      source: "transcript",
    };
  }

  if (value) {
    return {
      ok: true,
      value,
      rawTranscriptValue,
      modelValue: value,
      source: "model",
    };
  }

  return {
    ok: false,
    error: "INCOMPATIBLE_DATETIME_VALUE",
    value: "",
    rawTranscriptValue,
    modelValue: value,
    source: "none",
  };
}

function resolveNumberValue(params: {
  value: string;
  rawTranscriptValue: string;
}): RealtimeSubmittedStepValueResult {
  const { value, rawTranscriptValue } = params;

  const transcriptLooksNumeric = isNumberLike(rawTranscriptValue);
  const modelLooksNumeric = isNumberLike(value);

  if (!modelLooksNumeric) {
    return {
      ok: false,
      error: "INCOMPATIBLE_NUMBER_TRANSCRIPT",
      value: "",
      rawTranscriptValue,
      modelValue: value,
      source: "none",
    };
  }

  if (!transcriptLooksNumeric) {
    return {
      ok: false,
      error: "INCOMPATIBLE_NUMBER_TRANSCRIPT",
      value: "",
      rawTranscriptValue,
      modelValue: value,
      source: "none",
    };
  }

  return {
    ok: true,
    value,
    rawTranscriptValue,
    modelValue: value,
    source: "model",
  };
}

export function resolveRealtimeSubmittedStepValue(params: {
  step: BookingFlowStepLike;
  value: string;
  rawTranscriptValue: string;
  modelValue: string;
  timeZone: string;
}): RealtimeSubmittedStepValueResult {
  const { step, rawTranscriptValue, timeZone } = params;

  const value = clean(params.value || params.modelValue || "");
  const expectedType = resolveExpectedType(step);

  if (!value && !rawTranscriptValue) {
    return {
      ok: false,
      error: "EMPTY_SUBMITTED_VALUE",
      value: "",
      rawTranscriptValue,
      modelValue: clean(params.modelValue || ""),
      source: "none",
    };
  }

  if (isDatetimeStep(step) || expectedType === "datetime") {
    return resolveDatetimeValue({
      value,
      rawTranscriptValue,
      timeZone,
    });
  }

  if (expectedType === "number") {
    return resolveNumberValue({
      value,
      rawTranscriptValue,
    });
  }

  return {
    ok: true,
    value,
    rawTranscriptValue,
    modelValue: value,
    source: "model",
  };
}