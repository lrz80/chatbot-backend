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
        | "INCOMPATIBLE_NUMBER_VALUE"
        | "INCOMPATIBLE_DATETIME_VALUE"
        | "INCOMPATIBLE_CHOICE_VALUE";
      value: "";
      rawTranscriptValue: string;
      modelValue: string;
      source: "none";
    };

function getValidationConfig(
  step: BookingFlowStepLike
): Record<string, unknown> {
  return step.validation_config && typeof step.validation_config === "object"
    ? (step.validation_config as Record<string, unknown>)
    : {};
}

function getValidationSlot(step: BookingFlowStepLike): string {
  const validationConfig = getValidationConfig(step);

  return typeof validationConfig.slot === "string"
    ? clean(validationConfig.slot)
    : "";
}

function resolveExpectedType(step: BookingFlowStepLike): string {
  return clean(step.expected_type || "").toLowerCase();
}

function isDatetimeStep(step: BookingFlowStepLike): boolean {
  const stepKey = clean(step.step_key).toLowerCase();
  const slot = getValidationSlot(step).toLowerCase();

  return stepKey === "datetime" || slot === "datetime";
}

function hasDigit(value: string): boolean {
  return /\d/.test(value);
}

function resolveValidationConfigType(step: BookingFlowStepLike): string {
  const validationConfig = getValidationConfig(step);

  return typeof validationConfig.type === "string"
    ? clean(validationConfig.type).toLowerCase()
    : "";
}

function getChoiceOptions(step: BookingFlowStepLike): Array<{
  value: string;
  labels: string[];
}> {
  const validationConfig = getValidationConfig(step);
  const rawOptions = validationConfig.options;

  if (!Array.isArray(rawOptions)) {
    return [];
  }

  return rawOptions
    .map((option) => {
      if (typeof option === "string") {
        const value = clean(option);

        return {
          value,
          labels: [value],
        };
      }

      if (!option || typeof option !== "object") {
        return null;
      }

      const record = option as Record<string, unknown>;

      const value =
        typeof record.value === "string"
          ? clean(record.value)
          : typeof record.id === "string"
            ? clean(record.id)
            : typeof record.key === "string"
              ? clean(record.key)
              : "";

      const labels: string[] = [];

      if (typeof record.label === "string") {
        labels.push(clean(record.label));
      }

      if (typeof record.name === "string") {
        labels.push(clean(record.name));
      }

      if (Array.isArray(record.labels)) {
        for (const label of record.labels) {
          if (typeof label === "string") {
            labels.push(clean(label));
          }
        }
      }

      if (
        record.translations &&
        typeof record.translations === "object" &&
        !Array.isArray(record.translations)
      ) {
        for (const translatedValue of Object.values(
          record.translations as Record<string, unknown>
        )) {
          if (typeof translatedValue === "string") {
            labels.push(clean(translatedValue));
          }

          if (Array.isArray(translatedValue)) {
            for (const item of translatedValue) {
              if (typeof item === "string") {
                labels.push(clean(item));
              }
            }
          }
        }
      }

      if (!value && labels.length === 0) {
        return null;
      }

      return {
        value: value || labels[0],
        labels: Array.from(new Set([value, ...labels].filter(Boolean))),
      };
    })
    .filter((option): option is { value: string; labels: string[] } =>
      Boolean(option?.value)
    );
}

function resolveChoiceValue(params: {
  step: BookingFlowStepLike;
  value: string;
  rawTranscriptValue: string;
  modelValue: string;
}): RealtimeSubmittedStepValueResult {
  const { step, value, rawTranscriptValue, modelValue } = params;

  const options = getChoiceOptions(step);

  if (options.length === 0) {
    return {
      ok: false,
      error: "INCOMPATIBLE_CHOICE_VALUE",
      value: "",
      rawTranscriptValue,
      modelValue,
      source: "none",
    };
  }

  const normalizedValue = normalizeComparable(value);
  const normalizedTranscript = normalizeComparable(rawTranscriptValue);

  for (const option of options) {
    const normalizedOptionValue = normalizeComparable(option.value);

    if (normalizedValue && normalizedValue === normalizedOptionValue) {
      return {
        ok: true,
        value: option.value,
        rawTranscriptValue,
        modelValue,
        source: "model",
      };
    }

    for (const label of option.labels) {
      const normalizedLabel = normalizeComparable(label);

      if (!normalizedLabel) continue;

      const modelMatches =
        normalizedValue &&
        (normalizedValue === normalizedLabel ||
          normalizedValue.includes(normalizedLabel) ||
          normalizedLabel.includes(normalizedValue));

      const transcriptMatches =
        normalizedTranscript &&
        (normalizedTranscript === normalizedLabel ||
          normalizedTranscript.includes(normalizedLabel) ||
          normalizedLabel.includes(normalizedTranscript));

      if (modelMatches || transcriptMatches) {
        return {
          ok: true,
          value: option.value,
          rawTranscriptValue,
          modelValue,
          source: modelMatches ? "model" : "transcript",
        };
      }
    }
  }

  return {
    ok: false,
    error: "INCOMPATIBLE_CHOICE_VALUE",
    value: "",
    rawTranscriptValue,
    modelValue,
    source: "none",
  };
}

function resolveDatetimeValue(params: {
  value: string;
  rawTranscriptValue: string;
  modelValue: string;
  timeZone: string;
}): RealtimeSubmittedStepValueResult {
  const { value, rawTranscriptValue, modelValue, timeZone } = params;

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
      modelValue,
      source: "model",
    };
  }

  if (transcriptValueHasDateAnchor) {
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
    error: "INCOMPATIBLE_DATETIME_VALUE",
    value: "",
    rawTranscriptValue,
    modelValue,
    source: "none",
  };
}

function resolveNumberValue(params: {
  value: string;
  rawTranscriptValue: string;
  modelValue: string;
}): RealtimeSubmittedStepValueResult {
  const { value, rawTranscriptValue, modelValue } = params;

  /**
   * No hardcoded language words here.
   *
   * For expected_type="number", the realtime model/tool must canonicalize
   * spoken numbers into a numeric value. Example:
   *
   * caller says: "veinte libras"
   * tool value should be: "20" or "20 libras"
   *
   * If the model cannot canonicalize to digits, we retry instead of guessing.
   */
  if (!hasDigit(value)) {
    return {
      ok: false,
      error: "INCOMPATIBLE_NUMBER_VALUE",
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

export function resolveRealtimeSubmittedStepValue(params: {
  step: BookingFlowStepLike;
  value: string;
  rawTranscriptValue: string;
  modelValue: string;
  timeZone: string;
}): RealtimeSubmittedStepValueResult {
  const { step, rawTranscriptValue, timeZone } = params;

  const modelValue = clean(params.modelValue || params.value || "");
  const value = clean(params.value || params.modelValue || "");
  const expectedType = resolveExpectedType(step);
  const validationType = resolveValidationConfigType(step);

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

  if (validationType === "choice" || expectedType === "choice") {
    return resolveChoiceValue({
      step,
      value,
      rawTranscriptValue,
      modelValue,
    });
  }

  if (isDatetimeStep(step) || expectedType === "datetime") {
    return resolveDatetimeValue({
      value,
      rawTranscriptValue,
      modelValue,
      timeZone,
    });
  }

  if (expectedType === "number") {
    return resolveNumberValue({
      value,
      rawTranscriptValue,
      modelValue,
    });
  }

  return {
    ok: true,
    value,
    rawTranscriptValue,
    modelValue,
    source: "model",
  };
}