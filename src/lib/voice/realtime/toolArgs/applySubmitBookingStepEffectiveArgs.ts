//src/lib/voice/realtime/toolArgs/applySubmitBookingStepEffectiveArgs.ts
import type { CallState } from "../../types";
import { clean } from "../utils/clean";
import { resolveSubmitBookingStepForwardedValue } from "./resolveSubmitBookingStepForwardedValue";

type ValueCandidate = {
  source: "model" | "transcript";
  value: string;
};

type ApplySubmitBookingStepEffectiveArgsParams = {
  effectiveToolArgs: Record<string, any>;
  rawToolArgs: Record<string, any>;
  realtimeState: CallState;
  lastUserTranscript: string;
};

export function applySubmitBookingStepEffectiveArgs(
  params: ApplySubmitBookingStepEffectiveArgsParams
): Record<string, any> {
  const { effectiveToolArgs, rawToolArgs, realtimeState, lastUserTranscript } =
    params;

  const modelValue = clean(rawToolArgs.value);
  const transcriptValue = clean(lastUserTranscript);

  const currentTranscriptSeq =
    typeof realtimeState.lastUserTranscriptSeq === "number"
      ? realtimeState.lastUserTranscriptSeq
      : -1;

  const promptAnchorSeq =
    typeof realtimeState.pendingBookingStepPromptAnchorSeq === "number"
      ? realtimeState.pendingBookingStepPromptAnchorSeq
      : -1;

  const stepKey = clean(effectiveToolArgs.step_key || rawToolArgs.step_key);
  const expectedType = clean(
    (realtimeState as any).pendingBookingStepExpectedType
  ).toLowerCase();
  const slot = clean((realtimeState as any).pendingBookingStepSlot);

  const forwardedValue = resolveSubmitBookingStepForwardedValue({
    stepKey,
    expectedType,
    slot,
    modelValue,
    transcriptValue,
    currentTranscriptSeq,
    promptAnchorSeq,
  });

  const prefersModelCandidate =
    stepKey === "service" ||
    stepKey === "datetime" ||
    expectedType === "datetime" ||
    expectedType === "number" ||
    expectedType === "phone" ||
    expectedType === "email" ||
    slot === "service_address" ||
    slot === "customer_phone" ||
    slot === "customer_email";

  const valueCandidates: ValueCandidate[] = prefersModelCandidate
    ? [
        modelValue
          ? {
              source: "model",
              value: modelValue,
            }
          : null,
        transcriptValue && forwardedValue === transcriptValue
          ? {
              source: "transcript",
              value: transcriptValue,
            }
          : null,
      ].filter((candidate): candidate is ValueCandidate => Boolean(candidate))
    : [
        transcriptValue
          ? {
              source: "transcript",
              value: transcriptValue,
            }
          : null,
        modelValue
          ? {
              source: "model",
              value: modelValue,
            }
          : null,
      ].filter((candidate): candidate is ValueCandidate => Boolean(candidate));

  return {
    ...effectiveToolArgs,
    value: forwardedValue,
    model_value: modelValue,
    transcript_value: transcriptValue,
    value_candidates: valueCandidates,
  };
}