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
import { resolveRealtimeStructuredValue } from "./resolvers/resolveRealtimeStructuredValue";

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

function resolveValidationConfigKind(step: BookingFlowStepLike): string {
  const validationConfig = getValidationConfig(step);

  return typeof validationConfig.kind === "string"
    ? clean(validationConfig.kind).toLowerCase()
    : "";
}

function isDatetimeStep(step: BookingFlowStepLike): boolean {
  const stepKey = clean(step.step_key).toLowerCase();
  const slot = getValidationSlot(step).toLowerCase();

  return stepKey === "datetime" || slot === "datetime";
}

function buildIncompatibleTextResult(params: {
  rawTranscriptValue: string;
  modelValue: string;
}): RealtimeSubmittedStepValueResult {
  return {
    ok: false,
    error: "INCOMPATIBLE_TEXT_VALUE",
    value: "",
    rawTranscriptValue: params.rawTranscriptValue,
    modelValue: params.modelValue,
    source: "none",
  };
}

function isCustomerNameSlot(slot: string): boolean {
  return clean(slot).toLowerCase() === "customer_name";
}

function textLooksLikeDatetimeForCurrentTenant(params: {
  value: string;
  rawTranscriptValue: string;
  modelValue: string;
  timeZone: string;
}): boolean {
  const candidate =
    clean(params.rawTranscriptValue) ||
    clean(params.value) ||
    clean(params.modelValue);

  if (!candidate) return false;

  const datetimeResult = resolveRealtimeDatetimeValue({
    value: candidate,
    rawTranscriptValue: candidate,
    modelValue: candidate,
    timeZone: params.timeZone,
  });

  return datetimeResult.ok === true;
}

function resolveStructuredDatetimeProtocolValue(params: {
  value: string;
  rawTranscriptValue: string;
  modelValue: string;
}): RealtimeSubmittedStepValueResult | null {
  const candidates = [params.modelValue, params.value]
    .map((candidate) => clean(candidate))
    .filter(Boolean);

  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) {
      continue;
    }

    try {
      const parsed = JSON.parse(candidate);

      if (!parsed || typeof parsed !== "object") {
        continue;
      }

      const status = clean((parsed as any).status).toLowerCase();

      if (status === "unknown") {
        return {
          ok: false,
          error: "INCOMPATIBLE_DATETIME_VALUE",
          value: "",
          rawTranscriptValue: params.rawTranscriptValue,
          modelValue: params.modelValue,
          source: "none",
        };
      }

      if (status !== "resolved") {
        continue;
      }

      const dateText = clean((parsed as any).date_text);
      const timeText = clean((parsed as any).time_text);

      if (!dateText || !timeText) {
        return {
          ok: false,
          error: "INCOMPATIBLE_DATETIME_VALUE",
          value: "",
          rawTranscriptValue: params.rawTranscriptValue,
          modelValue: params.modelValue,
          source: "none",
        };
      }

      return {
        ok: true,
        value: candidate,
        rawTranscriptValue: params.rawTranscriptValue,
        modelValue: params.modelValue,
        source: "model",
      };
    } catch {
      continue;
    }
  }

  return null;
}

function isConfirmationProtocolValue(value: unknown): boolean {
  const normalized = clean(value).toLowerCase();

  return (
    normalized === "confirm" ||
    normalized === "cancel" ||
    normalized === "unknown"
  );
}

function resolveRealtimeConfirmationProtocolValue(params: {
  value: string;
  rawTranscriptValue: string;
  modelValue: string;
}): RealtimeSubmittedStepValueResult {
  const modelValue = clean(params.modelValue).toLowerCase();
  const value = clean(params.value).toLowerCase();

  if (isConfirmationProtocolValue(modelValue)) {
    return {
      ok: true,
      value: modelValue,
      rawTranscriptValue: params.rawTranscriptValue,
      modelValue: params.modelValue,
      source: "model",
    };
  }

  if (isConfirmationProtocolValue(value)) {
    return {
      ok: true,
      value,
      rawTranscriptValue: params.rawTranscriptValue,
      modelValue: params.modelValue,
      source: "model",
    };
  }

  return {
    ok: false,
    error: "INCOMPATIBLE_TEXT_VALUE",
    value: "",
    rawTranscriptValue: params.rawTranscriptValue,
    modelValue: params.modelValue,
    source: "none",
  };
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

  const rawTranscriptValue = clean(params.rawTranscriptValue);
  const modelValue = clean(params.modelValue);
  const value = clean(params.value);

  const expectedType = resolveExpectedType(step);
  const validationType = resolveValidationConfigType(step);
  const validationKind = resolveValidationConfigKind(step);
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

  if (!value && !rawTranscriptValue && !modelValue) {
    return {
      ok: false,
      error: "EMPTY_SUBMITTED_VALUE",
      value: "",
      rawTranscriptValue,
      modelValue,
      source: "none",
    };
  }

  if (expectedType === "confirmation" || slot === "confirmation") {
    return resolveRealtimeConfirmationProtocolValue({
      value,
      rawTranscriptValue,
      modelValue,
    });
  }

  if (validationKind === "structured") {
    const structuredResult = resolveRealtimeStructuredValue({
      step,
      value,
      rawTranscriptValue,
      modelValue,
    });

    return {
      ...structuredResult,
      rawTranscriptValue,
      modelValue,
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
    const structuredDatetimeResult = resolveStructuredDatetimeProtocolValue({
      value,
      rawTranscriptValue,
      modelValue,
    });

    if (structuredDatetimeResult) {
      return structuredDatetimeResult;
    }

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

  if (
    isCustomerNameSlot(slot) &&
    textLooksLikeDatetimeForCurrentTenant({
      value,
      rawTranscriptValue,
      modelValue,
      timeZone,
    })
  ) {
    return buildIncompatibleTextResult({
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