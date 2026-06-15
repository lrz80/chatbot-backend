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
  const rawStepKey = clean(rawToolArgs.step_key);

  const expectedType = clean(
    (realtimeState as any).pendingBookingStepExpectedType
  ).toLowerCase();

  const slot = clean((realtimeState as any).pendingBookingStepSlot);

  const phoneConfirmOrReplaceStep = isPhoneConfirmOrReplaceStep({
    realtimeState,
    stepKey,
    expectedType,
    slot,
  });

  if (phoneConfirmOrReplaceStep && rawStepKey && rawStepKey !== stepKey) {
    console.warn(
      "[VOICE_REALTIME][STALE_PHONE_CONFIRM_TOOL_CALL_PROTOCOL_FALLBACK]",
      {
        pendingStepKey: stepKey,
        rawStepKey,
        modelValue,
        transcriptValue,
        currentTranscriptSeq,
        promptAnchorSeq,
      }
    );

    const valueCandidates: ValueCandidate[] = [
      {
        source: "model",
        value: PHONE_CONFIRM_UNKNOWN,
      },
    ];

    return {
      ...effectiveToolArgs,
      value: PHONE_CONFIRM_UNKNOWN,
      model_value: modelValue,
      transcript_value: transcriptValue,
      value_candidates: valueCandidates,
      stale_phone_confirm_tool_call: true,
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