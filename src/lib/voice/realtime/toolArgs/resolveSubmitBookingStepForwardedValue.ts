//src/lib/voice/realtime/toolArgs/resolveSubmitBookingStepForwardedValue.ts
import { clean } from "../utils/clean";

type ResolveSubmitBookingStepForwardedValueParams = {
  stepKey: string;
  expectedType?: unknown;
  slot?: unknown;
  modelValue: unknown;
  transcriptValue: unknown;
  currentTranscriptSeq: number;
  promptAnchorSeq: number;
};

export function resolveSubmitBookingStepForwardedValue(
  params: ResolveSubmitBookingStepForwardedValueParams
): string {
  const stepKey = clean(params.stepKey);
  const expectedType = clean(params.expectedType).toLowerCase();
  const slot = clean(params.slot);
  const modelValue = clean(params.modelValue);
  const transcriptValue = clean(params.transcriptValue);

  const transcriptIsAfterPrompt =
    Number.isFinite(params.currentTranscriptSeq) &&
    Number.isFinite(params.promptAnchorSeq) &&
    params.currentTranscriptSeq > params.promptAnchorSeq;

  if (!modelValue && !transcriptValue) {
    return "";
  }

  const addressSlots = new Set([
    "address",
    "service_address",
    "property_address",
    "customer_address",
  ]);

  const shouldPreferModelValue =
    stepKey === "service" ||
    stepKey === "datetime" ||
    expectedType === "datetime" ||
    expectedType === "number" ||
    expectedType === "address" ||
    expectedType === "phone" ||
    expectedType === "email" ||
    addressSlots.has(slot) ||
    slot === "customer_phone" ||
    slot === "customer_email";

  if (shouldPreferModelValue) {
    if (modelValue) return modelValue;
    if (transcriptIsAfterPrompt) return transcriptValue;
    return "";
  }

  if (transcriptIsAfterPrompt && transcriptValue) {
    return transcriptValue;
  }

  if (modelValue) {
    return modelValue;
  }

  return transcriptValue;
}