// src/lib/voice/realtime/bookingStep/resolvers/resolveRealtimeChoiceValue.ts
import {
  clean,
  normalizeComparable,
  type BookingFlowStepLike,
} from "../../realtimeBookingFlowUtils";
import {
  isModelValueGroundedInTranscript,
  tokenizeComparable,
} from "./grounding";

function getValidationConfig(
  step: BookingFlowStepLike
): Record<string, unknown> {
  return step.validation_config && typeof step.validation_config === "object"
    ? (step.validation_config as Record<string, unknown>)
    : {};
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
  const normalizedTranscript = normalizeComparable(params.rawTranscriptValue);

  if (!normalizedTranscript) {
    return false;
  }

  for (const label of params.labels) {
    const normalizedLabel = normalizeComparable(label);

    if (!normalizedLabel) {
      continue;
    }

    if (normalizedTranscript === normalizedLabel) {
      return true;
    }

    const labelTokens = tokenizeComparable(label);
    const transcriptTokens = new Set(tokenizeComparable(params.rawTranscriptValue));

    if (
      labelTokens.length > 0 &&
      labelTokens.every((token) => transcriptTokens.has(token))
    ) {
      return true;
    }
  }

  return false;
}

export function resolveRealtimeChoiceValue(params: {
  step: BookingFlowStepLike;
  value: string;
  rawTranscriptValue: string;
  modelValue: string;
}) {
  const step = params.step;
  const value = clean(params.value);
  const rawTranscriptValue = clean(params.rawTranscriptValue);
  const modelValue = clean(params.modelValue);

  const options = getChoiceOptions(step);

  if (options.length === 0) {
    return {
      ok: false as const,
      error: "INCOMPATIBLE_CHOICE_VALUE" as const,
      value: "" as const,
      rawTranscriptValue,
      modelValue,
      source: "none" as const,
    };
  }

  const normalizedValue = normalizeComparable(value);
  const normalizedTranscript = normalizeComparable(rawTranscriptValue);

  for (const option of options) {
    const normalizedOptionValue = normalizeComparable(option.value);

    const modelMatchesOptionValue =
      Boolean(normalizedValue) && normalizedValue === normalizedOptionValue;

    const transcriptMatchesOptionValue =
      Boolean(normalizedTranscript) &&
      normalizedTranscript === normalizedOptionValue;

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
        ok: true as const,
        value: option.value,
        rawTranscriptValue,
        modelValue,
        source:
          transcriptMatchesOptionValue || transcriptMatchesOptionLabel
            ? ("transcript" as const)
            : ("model" as const),
      };
    }
  }

  return {
    ok: false as const,
    error: "INCOMPATIBLE_CHOICE_VALUE" as const,
    value: "" as const,
    rawTranscriptValue,
    modelValue,
    source: "none" as const,
  };
}