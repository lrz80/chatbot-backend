// src/lib/voice/realtime/toolArgs/selectSubmitBookingStepValue.ts

export type SubmitBookingStepValueSource =
  | "transcript_only"
  | "model_only_no_transcript"
  | "model_matches_transcript"
  | "model_differs_from_transcript";

export type SubmitBookingStepValueSelection = {
  value: string;
  valueSource: SubmitBookingStepValueSource;
  modelValue: string;
  transcriptValue: string;
  hasTranscript: boolean;
  modelMatchesTranscript: boolean;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeForLooseCompare(value: unknown): string {
  return clean(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * This function does not validate the booking value.
 *
 * It only decides which value is safe to forward as primary evidence.
 * The canonical resolver still decides if the value is valid for the current step.
 */
export function selectSubmitBookingStepValue(params: {
  modelValue: unknown;
  transcriptValue: unknown;
}): SubmitBookingStepValueSelection {
  const modelValue = clean(params.modelValue);
  const transcriptValue = clean(params.transcriptValue);

  const normalizedModel = normalizeForLooseCompare(modelValue);
  const normalizedTranscript = normalizeForLooseCompare(transcriptValue);

  const hasTranscript = Boolean(transcriptValue);

  const modelMatchesTranscript =
    Boolean(normalizedModel) &&
    Boolean(normalizedTranscript) &&
    (normalizedModel === normalizedTranscript ||
      normalizedTranscript.includes(normalizedModel) ||
      normalizedModel.includes(normalizedTranscript));

  if (!hasTranscript) {
    return {
      value: modelValue,
      valueSource: "model_only_no_transcript",
      modelValue,
      transcriptValue,
      hasTranscript,
      modelMatchesTranscript: false,
    };
  }

  if (!modelValue) {
    return {
      value: transcriptValue,
      valueSource: "transcript_only",
      modelValue,
      transcriptValue,
      hasTranscript,
      modelMatchesTranscript: false,
    };
  }

  if (modelMatchesTranscript) {
    return {
      value: modelValue,
      valueSource: "model_matches_transcript",
      modelValue,
      transcriptValue,
      hasTranscript,
      modelMatchesTranscript: true,
    };
  }

  /**
   * Model and transcript differ.
   *
   * Forward the transcript as primary evidence, but keep both values available
   * so the canonical resolver can decide using real configured options.
   */
  return {
    value: transcriptValue,
    valueSource: "model_differs_from_transcript",
    modelValue,
    transcriptValue,
    hasTranscript,
    modelMatchesTranscript: false,
  };
}