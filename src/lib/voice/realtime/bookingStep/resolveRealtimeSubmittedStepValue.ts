// src/lib/voice/realtime/bookingStep/resolveRealtimeSubmittedStepValue.ts
import {
  clean,
  type BookingFlowStepLike,
} from "../realtimeBookingFlowUtils";
import { getStepSlot } from "../realtimeBookingFlowUtils";
import { resolveRealtimePhoneValue } from "./resolvers/resolveRealtimePhoneValue";
import { resolveRealtimeTextValue } from "./resolvers/resolveRealtimeTextValue";
import { resolveRealtimeDatetimeValue } from "./resolvers/resolveRealtimeDatetimeValue";
import { resolveRealtimeNumberValue } from "./resolvers/resolveRealtimeNumberValue";
import { resolveRealtimeChoiceValue } from "./resolvers/resolveRealtimeChoiceValue";

export type RealtimeSubmittedStepValueSource =
  | "model"
  | "transcript"
  | "caller_phone"
  | "spoken_phone";

export type RealtimeSubmittedStepValueError =
  | "EMPTY_SUBMITTED_VALUE"
  | "INCOMPATIBLE_NUMBER_VALUE"
  | "INCOMPATIBLE_DATETIME_VALUE"
  | "INCOMPATIBLE_CHOICE_VALUE"
  | "INCOMPATIBLE_TEXT_VALUE"
  | "PHONE_REQUIRED"
  | "INVALID_PHONE_VALUE";

export type RealtimeSubmittedStepValueResult =
  | {
      ok: true;
      value: string;
      rawTranscriptValue: string;
      modelValue: string;
      source: RealtimeSubmittedStepValueSource;
    }
  | {
      ok: false;
      error: RealtimeSubmittedStepValueError;
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

function resolveValidationConfigType(step: BookingFlowStepLike): string {
  const validationConfig = getValidationConfig(step);

  return typeof validationConfig.type === "string"
    ? clean(validationConfig.type).toLowerCase()
    : "";
}

function isDatetimeStep(step: BookingFlowStepLike): boolean {
  const stepKey = clean(step.step_key).toLowerCase();
  const slot = getValidationSlot(step).toLowerCase();

  return stepKey === "datetime" || slot === "datetime";
}

export function resolveRealtimeSubmittedStepValue(params: {
  step: BookingFlowStepLike;
  value: string;
  rawTranscriptValue: string;
  modelValue: string;
  timeZone: string;
  callerPhone: string | null;
}): RealtimeSubmittedStepValueResult {
  const { step, timeZone } = params;

  const rawTranscriptValue = clean(params.rawTranscriptValue || "");
  const modelValue = clean(params.modelValue || params.value || "");
  const value = clean(params.value || params.modelValue || "");
  const expectedType = resolveExpectedType(step);
  const validationType = resolveValidationConfigType(step);
  const slot = getStepSlot(step);

  if (slot === "customer_phone" || expectedType === "phone") {
    const phoneResult = resolveRealtimePhoneValue({
      value,
      rawTranscriptValue,
      modelValue,
      callerPhone: params.callerPhone,
    });

    return {
      ...phoneResult,
      rawTranscriptValue,
      modelValue,
    };
  }

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
    return resolveRealtimeChoiceValue({
      step,
      value,
      rawTranscriptValue,
      modelValue,
    });
  }

  if (isDatetimeStep(step) || expectedType === "datetime") {
    return resolveRealtimeDatetimeValue({
      value,
      rawTranscriptValue,
      modelValue,
      timeZone,
    });
  }

  if (expectedType === "number") {
    return resolveRealtimeNumberValue({
      value,
      rawTranscriptValue,
      modelValue,
    });
  }

  return resolveRealtimeTextValue({
    value,
    rawTranscriptValue,
    modelValue,
    allowModelNormalization: slot === "service",
  });
}