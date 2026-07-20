// src/lib/voice/realtime/toolArgs/applySubmitBookingStepEffectiveArgs.ts
import type { CallState } from "../../types";
import {
  PHONE_CONFIRM_REPLACE,
  PHONE_CONFIRM_UNKNOWN,
  PHONE_CONFIRM_USE_INBOUND,
} from "../bookingStep/resolvers/resolveRealtimePhoneValue";
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

function serializeToolArgValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return clean(value);
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return clean(value);
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }

  return clean(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getPendingBookingStepValidationConfig(
  realtimeState: CallState
): Record<string, unknown> {
  const state = realtimeState as any;

  if (isRecord(state.pendingBookingStepValidationConfig)) {
    return state.pendingBookingStepValidationConfig;
  }

  return {};
}

function isPhoneConfirmOrReplaceStep(params: {
  realtimeState: CallState;
  stepKey: string;
  expectedType: string;
  slot: string;
}): boolean {
  const validationConfig = getPendingBookingStepValidationConfig(
    params.realtimeState
  );

  const validationMode = clean(validationConfig.mode).toLowerCase();

  const useInboundCaller =
    validationConfig.use_inbound_caller === true ||
    validationConfig.useInboundCaller === true;

  return (
    clean(params.stepKey) === "phone" &&
    clean(params.slot).toLowerCase() === "customer_phone" &&
    clean(params.expectedType).toLowerCase() === "phone" &&
    validationMode === "confirm_or_replace" &&
    useInboundCaller === true
  );
}

function isPhoneConfirmationProtocolValue(value: string): boolean {
  const normalized = clean(value).toLowerCase();

  return (
    normalized === PHONE_CONFIRM_USE_INBOUND ||
    normalized === PHONE_CONFIRM_REPLACE ||
    normalized === PHONE_CONFIRM_UNKNOWN
  );
}

function hasPhoneDigits(value: string): boolean {
  return /\d/.test(value);
}

function isStructuredDatetimeProtocolValue(value: string): boolean {
  const trimmed = clean(value);

  if (!trimmed.startsWith("{")) {
    return false;
  }

  try {
    const parsed = JSON.parse(trimmed);

    return (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.status === "string"
    );
  } catch {
    return false;
  }
}

export function applySubmitBookingStepEffectiveArgs(
  params: ApplySubmitBookingStepEffectiveArgsParams
): Record<string, any> {
  const { effectiveToolArgs, rawToolArgs, realtimeState, lastUserTranscript } =
    params;

  const modelValue = serializeToolArgValue(rawToolArgs.value);
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
  const rawStepKey = clean(rawToolArgs.step_key);

  const expectedType = clean(
    (realtimeState as any).pendingBookingStepExpectedType
  ).toLowerCase();

  const slot = clean(
    (realtimeState as any).pendingBookingStepSlot
  ).toLowerCase();

  const phoneConfirmOrReplaceStep = isPhoneConfirmOrReplaceStep({
    realtimeState,
    stepKey,
    expectedType,
    slot,
  });

  if (phoneConfirmOrReplaceStep && rawStepKey && rawStepKey !== stepKey) {
    console.warn("[VOICE_REALTIME][STALE_PHONE_CONFIRM_TOOL_CALL_DROPPED]", {
      pendingStepKey: stepKey,
      rawStepKey,
      modelValue,
      transcriptValue,
      currentTranscriptSeq,
      promptAnchorSeq,
    });

    return {
      ...effectiveToolArgs,
      value: "",
      model_value: modelValue,
      transcript_value: transcriptValue,
      value_candidates: [],
      stale_phone_confirm_tool_call: true,
      should_drop_submit_booking_step: true,
      original_step_key: rawStepKey,
      original_model_value: modelValue,
    };
  }

  if (phoneConfirmOrReplaceStep) {
    const normalizedModelValue = modelValue.toLowerCase();

    const forwardedPhoneConfirmValue = isPhoneConfirmationProtocolValue(
      modelValue
    )
      ? normalizedModelValue
      : hasPhoneDigits(modelValue)
        ? modelValue
        : PHONE_CONFIRM_UNKNOWN;

    const valueCandidates: ValueCandidate[] = [
      {
        source: "model",
        value: forwardedPhoneConfirmValue,
      },
    ];

    return {
      ...effectiveToolArgs,
      value: forwardedPhoneConfirmValue,
      model_value: modelValue,
      transcript_value: transcriptValue,
      value_candidates: valueCandidates,
    };
  }

  if (
    expectedType === "datetime" &&
    isStructuredDatetimeProtocolValue(modelValue)
  ) {
    const valueCandidates: ValueCandidate[] = [
      {
        source: "model",
        value: modelValue,
      },
    ];

    return {
      ...effectiveToolArgs,
      value: modelValue,
      model_value: modelValue,
      transcript_value: transcriptValue,
      value_candidates: valueCandidates,
    };
  }

  const forwardedValue = resolveSubmitBookingStepForwardedValue({
    stepKey,
    expectedType,
    slot,
    modelValue,
    transcriptValue,
    currentTranscriptSeq,
    promptAnchorSeq,
  });

  const addressSlots = new Set([
    "address",
    "service_address",
    "property_address",
    "customer_address",
  ]);

  const prefersModelCandidate =
    stepKey === "service" ||
    stepKey === "datetime" ||
    expectedType === "datetime" ||
    expectedType === "number" ||
    expectedType === "address" ||
    expectedType === "phone" ||
    expectedType === "email" ||
    addressSlots.has(slot.toLowerCase()) ||
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