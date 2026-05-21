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
        | "INCOMPATIBLE_CHOICE_VALUE"
        | "INCOMPATIBLE_TEXT_VALUE";
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

function tokenizeComparable(value: string): string[] {
  const normalized = normalizeComparable(value);

  return normalized
    .split(" ")
    .map((token) => clean(token))
    .filter(Boolean);
}

/**
 * This is the safety gate that prevents the model from submitting values
 * that were not actually said by the caller in the current step.
 *
 * It allows canonical extraction only when the model value is grounded in the
 * transcript. Example:
 *
 * transcript: "Mi nombre es Luis Rojas"
 * model: "Luis Rojas"
 *
 * But blocks:
 *
 * transcript: "Hola, quiero agendar una cita"
 * model: "Diseño de cejas"
 */
function isModelValueGroundedInTranscript(params: {
  modelValue: string;
  rawTranscriptValue: string;
}): boolean {
  const { modelValue, rawTranscriptValue } = params;

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

  const allModelTokensAppearInTranscript = modelTokens.every((token) =>
    transcriptTokens.has(token)
  );

  if (allModelTokensAppearInTranscript) {
    return true;
  }

  return false;
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

function choiceLabelMatchesTranscript(params: {
  labels: string[];
  rawTranscriptValue: string;
}): boolean {
  const { labels, rawTranscriptValue } = params;

  const normalizedTranscript = normalizeComparable(rawTranscriptValue);

  if (!normalizedTranscript) {
    return false;
  }

  for (const label of labels) {
    const normalizedLabel = normalizeComparable(label);

    if (!normalizedLabel) {
      continue;
    }

    if (normalizedTranscript === normalizedLabel) {
      return true;
    }

    const labelTokens = tokenizeComparable(label);
    const transcriptTokens = new Set(tokenizeComparable(rawTranscriptValue));

    if (
      labelTokens.length > 0 &&
      labelTokens.every((token) => transcriptTokens.has(token))
    ) {
      return true;
    }
  }

  return false;
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

    const modelMatchesOptionValue =
      normalizedValue && normalizedValue === normalizedOptionValue;

    const transcriptMatchesOptionValue =
      normalizedTranscript && normalizedTranscript === normalizedOptionValue;

    const transcriptMatchesOptionLabel = choiceLabelMatchesTranscript({
      labels: option.labels,
      rawTranscriptValue,
    });

    const modelIsGrounded = isModelValueGroundedInTranscript({
      modelValue: value,
      rawTranscriptValue,
    });

    if (
      transcriptMatchesOptionValue ||
      transcriptMatchesOptionLabel ||
      (modelMatchesOptionValue && modelIsGrounded)
    ) {
      return {
        ok: true,
        value: option.value,
        rawTranscriptValue,
        modelValue,
        source:
          transcriptMatchesOptionValue || transcriptMatchesOptionLabel
            ? "transcript"
            : "model",
      };
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

  const transcriptValueHasDateAnchor =
    Boolean(rawTranscriptValue) &&
    hasExplicitVoiceDateAnchor({
      raw: rawTranscriptValue,
      timeZone,
    });

  if (!transcriptValueHasDateAnchor) {
    return {
      ok: false,
      error: "INCOMPATIBLE_DATETIME_VALUE",
      value: "",
      rawTranscriptValue,
      modelValue,
      source: "none",
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
      ok: true,
      value,
      rawTranscriptValue,
      modelValue,
      source: "model",
    };
  }

  return {
    ok: true,
    value: rawTranscriptValue,
    rawTranscriptValue,
    modelValue,
    source: "transcript",
  };
}

function resolveNumberValue(params: {
  value: string;
  rawTranscriptValue: string;
  modelValue: string;
}): RealtimeSubmittedStepValueResult {
  const { value, rawTranscriptValue, modelValue } = params;

  if (!rawTranscriptValue) {
    return {
      ok: false,
      error: "EMPTY_SUBMITTED_VALUE",
      value: "",
      rawTranscriptValue,
      modelValue,
      source: "none",
    };
  }

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

function resolveTextValue(params: {
  value: string;
  rawTranscriptValue: string;
  modelValue: string;
}): RealtimeSubmittedStepValueResult {
  const { value, rawTranscriptValue, modelValue } = params;

  if (!rawTranscriptValue && !value) {
    return {
      ok: false,
      error: "EMPTY_SUBMITTED_VALUE",
      value: "",
      rawTranscriptValue,
      modelValue,
      source: "none",
    };
  }

  if (
    value &&
    isModelValueGroundedInTranscript({
      modelValue: value,
      rawTranscriptValue,
    })
  ) {
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

export function resolveRealtimeSubmittedStepValue(params: {
  step: BookingFlowStepLike;
  value: string;
  rawTranscriptValue: string;
  modelValue: string;
  timeZone: string;
}): RealtimeSubmittedStepValueResult {
  const { step, timeZone } = params;

  const rawTranscriptValue = clean(params.rawTranscriptValue || "");
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

  return resolveTextValue({
    value,
    rawTranscriptValue,
    modelValue,
  });
}