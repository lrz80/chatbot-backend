//src/lib/voice/realtime/bookingStepValueValidators.ts
import {
  clean,
  canonicalizeGenericStepValue,
  normalizeComparable,
  type BookingFlowStepLike,
} from "./realtimeBookingFlowUtils";

export type StepValueValidationResult =
  | {
      ok: true;
      value: string;
    }
  | {
      ok: false;
      error: string;
    };

function hasAsciiDigit(value: string): boolean {
  return Array.from(value).some((char) => char >= "0" && char <= "9");
}

function isCanonicalBooleanLikeValue(params: {
  step: BookingFlowStepLike;
  value: string;
}): boolean {
  const canonicalValue = canonicalizeGenericStepValue(
    params.step,
    params.value
  );

  const comparable = normalizeComparable(canonicalValue);

  /**
   * These are internal canonical values, not tenant/business text.
   * User-facing language variants should be resolved by canonicalizeGenericStepValue.
   */
  return (
    comparable === "yes" ||
    comparable === "no" ||
    comparable === "true" ||
    comparable === "false"
  );
}

export function resolveExpectedTypeStepValue(params: {
  step: BookingFlowStepLike;
  value: string;
  modelValue?: string;
}): StepValueValidationResult {
  const expectedType = clean(params.step.expected_type).toLowerCase();

  const normalizedStepValue = canonicalizeGenericStepValue(
    params.step,
    params.value
  );

  if (expectedType !== "number") {
    return {
      ok: true,
      value: normalizedStepValue,
    };
  }

  const transcriptValue = clean(normalizedStepValue);
  const modelValue = clean(params.modelValue || "");

  if (!transcriptValue) {
    return {
      ok: false,
      error: "INVALID_NUMBER_STEP",
    };
  }

  if (
    isCanonicalBooleanLikeValue({
      step: params.step,
      value: transcriptValue,
    })
  ) {
    return {
      ok: false,
      error: "INVALID_NUMBER_STEP",
    };
  }

  if (hasAsciiDigit(transcriptValue)) {
    return {
      ok: true,
      value: transcriptValue,
    };
  }

  /**
   * Voice transcripts can produce number words like:
   * "veinte libras", "twenty pounds".
   *
   * The model_value is allowed only as numeric normalization,
   * not as a free source of truth.
   */
  if (modelValue && hasAsciiDigit(modelValue)) {
    return {
      ok: true,
      value: modelValue,
    };
  }

  return {
    ok: false,
    error: "INVALID_NUMBER_STEP",
  };
}