// src/lib/voice/realtime/toolArgs/buildEffectiveRealtimeToolArgs.ts

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export function buildEffectiveRealtimeToolArgs(params: {
  toolName: string;
  toolArgs: Record<string, any>;
  lastUserTranscript: string;
}): Record<string, any> {
  const { toolName, toolArgs, lastUserTranscript } = params;

  if (toolName !== "submit_booking_step") {
    return {
      ...toolArgs,
    };
  }

  const modelValue = clean(toolArgs.value || "");
  const rawTranscriptValue = clean(lastUserTranscript || "");

  return {
    ...toolArgs,
    step_key: clean(toolArgs.step_key || ""),
    value: modelValue,
    raw_transcript_value: rawTranscriptValue,
    model_value: modelValue,
  };
}