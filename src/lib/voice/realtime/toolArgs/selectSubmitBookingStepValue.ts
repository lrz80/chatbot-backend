//src/lib/voice/realtime/toolArgs/selectSubmitBookingStepValue.ts
export type SubmitBookingStepValueSource =
  | "model_extracted_value"
  | "fresh_user_transcript";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export function selectSubmitBookingStepValue(params: {
  modelValue: unknown;
  transcriptValue: unknown;
}): {
  value: string;
  valueSource: SubmitBookingStepValueSource;
} {
  const modelValue = clean(params.modelValue);
  const transcriptValue = clean(params.transcriptValue);

  if (modelValue) {
    return {
      value: modelValue,
      valueSource: "model_extracted_value",
    };
  }

  return {
    value: transcriptValue,
    valueSource: "fresh_user_transcript",
  };
}