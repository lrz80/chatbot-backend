// src/lib/voice/realtime/handlers/handleRealtimeSubmitBookingStep.ts

import type { CallState, VoiceLocale } from "../../types";
import {
  type BookingFlowStepLike,
  type BookingState,
} from "../realtimeBookingFlowUtils";
import { buildRealtimeStepRetryResult } from "../bookingStep/buildRealtimeStepRetryResult";
import { advanceRealtimeBookingStep } from "../bookingStep/advanceRealtimeBookingStep";
import { prepareRealtimeStepSubmission } from "../bookingStep/prepareRealtimeStepSubmission";
import { executeRealtimeStepRoute } from "../bookingStep/executeRealtimeStepRoute";
import { validateSubmitBookingStepFreshness } from "../toolGuards/validateSubmitBookingStepFreshness";
import { resolveConfiguredServiceOptionCandidate } from "../bookingStep/resolveConfiguredServiceOptionCandidate";
import { resolveGlobalConfirmationIntent } from "../bookingStep/resolveGlobalConfirmationIntent";
import {
  validateFieldServiceAddressStep,
} from "../bookingStep/validateFieldServiceAddressStep";

type RealtimeBookingContext = {
  tenant: any;
  cfg: any;
  callSid: string;
  didNumber: string;
  currentLocale: VoiceLocale;
  state: CallState;
  userInput: string;
  digits: string;
};

type HandleRealtimeSubmitBookingStepParams = {
  tenantId: string;
  callerPhone: string | null;
  args: Record<string, any>;
  bookingContext: RealtimeBookingContext;
  steps: BookingFlowStepLike[];
  buildRealtimeBookingState: (params: {
    steps: BookingFlowStepLike[];
    state: CallState;
    explicitCurrentIndex?: number | null;
    finalConfirmationGranted?: boolean;
    readyToCreate?: boolean;
  }) => BookingState;
  persistVoiceState: (params: {
    tenantId: string;
    callSid: string;
    state: CallState;
    locale: VoiceLocale;
  }) => Promise<void>;
};

type SubmitValueCandidate = {
  source: string;
  value: string;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeKey(value: unknown): string {
  return clean(value).toLowerCase();
}

function isConfirmationStep(step: BookingFlowStepLike | null): boolean {
  const stepKey = normalizeKey((step as any)?.step_key);
  const slot = normalizeKey((step as any)?.slot);
  const expectedType = normalizeKey((step as any)?.expected_type);
  const validationMode = normalizeKey((step as any)?.validation_mode);

  return (
    stepKey === "confirm" ||
    stepKey === "confirmation" ||
    stepKey === "offer_booking_sms" ||
    slot === "confirmation" ||
    expectedType === "confirmation" ||
    validationMode === "confirmation"
  );
}

function isAllowedConfirmationProtocolValue(value: unknown): boolean {
  const normalized = normalizeKey(value);

  return (
    normalized === "confirm" ||
    normalized === "cancel" ||
    normalized === "unknown"
  );
}

function getStructuredConfirmationIntent(value: unknown): string {
  const normalized = normalizeKey(value);

  if (normalized === "confirm" || normalized === "confirmed") {
    return "confirm";
  }

  if (
    normalized === "cancel" ||
    normalized === "cancelled" ||
    normalized === "canceled"
  ) {
    return "cancel";
  }

  if (normalized === "unknown") {
    return "unknown";
  }

  return "";
}

function getCurrentStepLike(params: {
  args: Record<string, any>;
  bookingContext: RealtimeBookingContext;
  steps: BookingFlowStepLike[];
}): BookingFlowStepLike | null {
  const submittedStepKey = clean(params.args.step_key);

  if (submittedStepKey) {
    const bySubmittedKey = params.steps.find(
      (step) => clean((step as any).step_key) === submittedStepKey
    );

    if (bySubmittedKey) return bySubmittedKey;
  }

  const pendingStepKey = clean(
    (params.bookingContext.state as any)?.pendingBookingStepKey
  );

  if (pendingStepKey) {
    const byPendingKey = params.steps.find(
      (step) => clean((step as any).step_key) === pendingStepKey
    );

    if (byPendingKey) return byPendingKey;
  }

  return null;
}

function isSensitiveBookingStep(params: {
  args: Record<string, any>;
  currentStep: BookingFlowStepLike | null;
}): boolean {
  const submittedStepKey = normalizeKey(params.args.step_key);
  const stepKey = normalizeKey((params.currentStep as any)?.step_key);
  const slot = normalizeKey((params.currentStep as any)?.slot);
  const expectedType = normalizeKey((params.currentStep as any)?.expected_type);

  const sensitiveStepKeys = new Set([
    "datetime",
    "date",
    "time",
    "name",
    "customer_name",
    "phone",
    "customer_phone",
    "email",
    "customer_email",
    "confirm",
    "confirmation",
  ]);

  const sensitiveSlots = new Set([
    "datetime",
    "date",
    "time",
    "customer_name",
    "customer_phone",
    "customer_email",
    "confirmation",
  ]);

  const sensitiveExpectedTypes = new Set([
    "datetime",
    "phone",
    "email",
    "confirmation",
  ]);

  return (
    sensitiveStepKeys.has(submittedStepKey) ||
    sensitiveStepKeys.has(stepKey) ||
    sensitiveSlots.has(slot) ||
    sensitiveExpectedTypes.has(expectedType)
  );
}

function isInternalAllowedModelToken(params: {
  value: string;
  currentStep: BookingFlowStepLike | null;
}): boolean {
  const value = clean(params.value);
  const slot = normalizeKey((params.currentStep as any)?.slot);
  const expectedType = normalizeKey((params.currentStep as any)?.expected_type);

  if (
    value === "__USE_CALLER_PHONE__" &&
    slot === "customer_phone" &&
    expectedType === "phone"
  ) {
    return true;
  }

  if (
    isConfirmationStep(params.currentStep) &&
    isAllowedConfirmationProtocolValue(value)
  ) {
    return true;
  }

  return false;
}

function buildSubmitValueCandidates(params: {
  args: Record<string, any>;
  bookingContext: RealtimeBookingContext;
  steps: BookingFlowStepLike[];
}): SubmitValueCandidate[] {
  const { args, bookingContext, steps } = params;

  const currentStep = getCurrentStepLike({
    args,
    bookingContext,
    steps,
  });

  const isSensitiveStep = isSensitiveBookingStep({
    args,
    currentStep,
  });

  const primaryValue = clean(args.value);
  const transcriptValue = clean(bookingContext.userInput);

  const rawCandidates = Array.isArray(args.value_candidates)
    ? args.value_candidates
    : [];

  const parsedCandidates = rawCandidates
    .map((candidate: any) => {
      const source = clean(candidate?.source) || "unknown";
      const value = clean(candidate?.value);

      if (!value) return null;

      return {
        source,
        value,
      };
    })
    .filter(Boolean) as SubmitValueCandidate[];

  const orderedCandidates: Array<SubmitValueCandidate | null> = [];

  const stepSlot = normalizeKey((currentStep as any)?.slot);
  const stepExpectedType = normalizeKey((currentStep as any)?.expected_type);
  const submittedStepKey = normalizeKey(args.step_key);

  const isServiceStep =
    submittedStepKey === "service" ||
    stepSlot === "service" ||
    stepExpectedType === "service";

  const isCurrentConfirmationStep = isConfirmationStep(currentStep);

  const primarySource = clean(args.resolved_candidate_source) || "model";

  if (isServiceStep && primaryValue && primarySource === "model") {
    orderedCandidates.push({
      source: "model",
      value: primaryValue,
    });
  }

  if (
    isCurrentConfirmationStep &&
    primaryValue &&
    primarySource === "model" &&
    isAllowedConfirmationProtocolValue(primaryValue)
  ) {
    orderedCandidates.push({
      source: "model",
      value: primaryValue,
    });
  }

  if (transcriptValue) {
    orderedCandidates.push({
      source: "transcript",
      value: transcriptValue,
    });
  }

  if (primaryValue) {
    if (
      !isSensitiveStep ||
      primarySource === "transcript" ||
      isInternalAllowedModelToken({
        value: primaryValue,
        currentStep,
      })
    ) {
      orderedCandidates.push({
        source: primarySource,
        value: primaryValue,
      });
    }
  }

  for (const candidate of parsedCandidates) {
    const source = clean(candidate.source);
    const value = clean(candidate.value);

    if (!value) continue;

    const isModelLike =
      source === "model" ||
      source === "selected" ||
      source === "assistant" ||
      source === "llm";

    if (
      isSensitiveStep &&
      isModelLike &&
      !isInternalAllowedModelToken({
        value,
        currentStep,
      })
    ) {
      continue;
    }

    orderedCandidates.push({
      source,
      value,
    });
  }

  if (isServiceStep) {
    const configuredOptionCandidate = resolveConfiguredServiceOptionCandidate({
      currentStep,
      values: [
        primaryValue,
        transcriptValue,
        ...parsedCandidates.map((candidate) => candidate.value),
      ],
    });

    if (configuredOptionCandidate) {
      orderedCandidates.push(configuredOptionCandidate);
    }
  }

  const seen = new Set<string>();

  const validCandidates = orderedCandidates.filter(
    (candidate): candidate is SubmitValueCandidate => candidate !== null
  );

  return validCandidates.filter((candidate) => {
    const normalizedValue = candidate.value.toLowerCase();
    const key = `${candidate.source}:${normalizedValue}`;

    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

function buildCandidateArgs(params: {
  args: Record<string, any>;
  candidate: SubmitValueCandidate;
}): Record<string, any> {
  return {
    ...params.args,
    value: params.candidate.value,
    resolved_candidate_source: params.candidate.source,
  };
}

function shouldTryNextCandidate(result: any): boolean {
  if (!result) return true;
  if (result.ok === true) return false;
  if (result.ok === false) return true;
  return false;
}

function getEffectiveConfirmationProtocolValue(params: {
  candidate: SubmitValueCandidate;
  prepared: any;
}): string {
  const candidateIntent = getStructuredConfirmationIntent(params.candidate.value);

  if (isAllowedConfirmationProtocolValue(candidateIntent)) {
    return candidateIntent;
  }

  const resolvedInputIntent = getStructuredConfirmationIntent(
    params.prepared?.resolvedInputValue
  );

  if (isAllowedConfirmationProtocolValue(resolvedInputIntent)) {
    return resolvedInputIntent;
  }

  const modelIntent = getStructuredConfirmationIntent(params.prepared?.modelValue);

  if (isAllowedConfirmationProtocolValue(modelIntent)) {
    return modelIntent;
  }

  return "";
}

export async function handleRealtimeSubmitBookingStep(
  params: HandleRealtimeSubmitBookingStepParams
): Promise<any> {
  const {
    tenantId,
    callerPhone,
    args,
    bookingContext,
    steps,
    buildRealtimeBookingState,
    persistVoiceState,
  } = params;

  const freshness = validateSubmitBookingStepFreshness({
    toolArgs: args,
    realtimeState: bookingContext.state,
    lastUserTranscript: bookingContext.userInput,
  });

  if (!freshness.ok) {
    console.warn("[VOICE_REALTIME][BOOKING_SUBMIT_BLOCKED_BY_FRESHNESS]", {
      callSid: bookingContext.callSid,
      error: freshness.error,
      submittedStepKey: freshness.submittedStepKey,
      pendingStepKey: freshness.pendingStepKey,
      currentTranscript: freshness.currentTranscript,
      submittedValue: freshness.submittedValue,
      currentTranscriptSeq: freshness.currentTranscriptSeq,
      promptAnchorSeq: freshness.promptAnchorSeq,
      lastSubmittedTranscriptSeq: freshness.lastSubmittedTranscriptSeq,
      effectiveAnchorSeq: freshness.effectiveAnchorSeq,
      hasNewHumanTranscript: freshness.hasNewHumanTranscript,
      isDuplicateSubmit: freshness.isDuplicateSubmit,
      isReusedTranscriptFromPreviousStep: freshness.isReusedTranscriptFromPreviousStep,
    });

    return {
      ok: false,
      error: freshness.error,
      next_required_step: freshness.pendingStepKey
        ? {
            step_key: freshness.pendingStepKey,
            prompt: bookingContext.state.pendingBookingStepPrompt || "",
            required: bookingContext.state.pendingBookingStepRequired ?? true,
          }
        : null,
    };
  }

  const candidates = buildSubmitValueCandidates({
    args,
    bookingContext,
    steps,
  });

  if (candidates.length === 0) {
    return {
      ok: false,
      error: "EMPTY_SUBMIT_BOOKING_STEP_VALUE",
      message: "No submitted value candidates were provided.",
    };
  }

  let lastPreparedFailure: any = null;
  let lastRouteReturn: any = null;

  for (const candidate of candidates) {
    const candidateArgs = buildCandidateArgs({
      args,
      candidate,
    });

    const prepared = prepareRealtimeStepSubmission({
      callerPhone,
      args: candidateArgs,
      bookingContext,
      steps,
      buildRealtimeBookingState,
    });

    if (!prepared.ok) {
      lastPreparedFailure = prepared.result;
      continue;
    }

    const isCurrentConfirmationStep = isConfirmationStep(prepared.currentStep);

    let effectiveConfirmationProtocolValue = isCurrentConfirmationStep
      ? getEffectiveConfirmationProtocolValue({
          candidate,
          prepared,
        })
      : "";

    if (isCurrentConfirmationStep && !effectiveConfirmationProtocolValue) {
      const currentStepKey = normalizeKey((prepared.currentStep as any)?.step_key);

      effectiveConfirmationProtocolValue = await resolveGlobalConfirmationIntent({
        locale: bookingContext.currentLocale,
        values: [
          candidate.value,
          prepared.resolvedInputValue,
          prepared.rawTranscriptValue,
          prepared.modelValue,
          bookingContext.userInput,
        ],
      });

      if (
        currentStepKey === "offer_booking_sms" &&
        effectiveConfirmationProtocolValue !== "confirm" &&
        effectiveConfirmationProtocolValue !== "cancel"
      ) {
        effectiveConfirmationProtocolValue = "unknown";
      }
    }

    if (isCurrentConfirmationStep) {
      if (!effectiveConfirmationProtocolValue) {
        const bookingState = buildRealtimeBookingState({
          steps,
          state: bookingContext.state,
          explicitCurrentIndex: prepared.currentIndex,
        });

        console.warn("[VOICE_REALTIME][BOOKING_CONFIRMATION_VALUE_REJECTED]", {
          callSid: bookingContext.callSid,
          stepKey: prepared.stepKey,
          targetSlot: prepared.targetSlot,
          candidateSource: candidate.source,
          rejectedValue: prepared.resolvedInputValue,
          candidateValue: candidate.value,
          rawTranscriptValue: prepared.rawTranscriptValue,
          modelValue: prepared.modelValue,
          reason: "CONFIRMATION_REQUIRES_PROTOCOL_VALUE",
        });

        return buildRealtimeStepRetryResult({
          error: "AMBIGUOUS_CONFIRMATION_VALUE",
          currentStep: prepared.currentStep,
          currentIndex: prepared.currentIndex,
          currentLocale: bookingContext.currentLocale,
          steps,
          bookingState,
        });
      }

      if (effectiveConfirmationProtocolValue === "unknown") {
        const bookingState = buildRealtimeBookingState({
          steps,
          state: bookingContext.state,
          explicitCurrentIndex: prepared.currentIndex,
        });

        console.warn("[VOICE_REALTIME][BOOKING_CONFIRMATION_UNKNOWN_RETRY]", {
          callSid: bookingContext.callSid,
          stepKey: prepared.stepKey,
          targetSlot: prepared.targetSlot,
          candidateSource: candidate.source,
          candidateValue: candidate.value,
          rawTranscriptValue: prepared.rawTranscriptValue,
          modelValue: prepared.modelValue,
        });

        return buildRealtimeStepRetryResult({
          error: "AMBIGUOUS_CONFIRMATION_VALUE",
          currentStep: prepared.currentStep,
          currentIndex: prepared.currentIndex,
          currentLocale: bookingContext.currentLocale,
          steps,
          bookingState,
        });
      }
    }

    const currentStepKey = normalizeKey((prepared.currentStep as any)?.step_key);

    if (
      currentStepKey === "offer_booking_sms" &&
      effectiveConfirmationProtocolValue !== "confirm" &&
      effectiveConfirmationProtocolValue !== "cancel"
    ) {
      const bookingState = buildRealtimeBookingState({
        steps,
        state: bookingContext.state,
        explicitCurrentIndex: prepared.currentIndex,
      });

      console.warn("[VOICE_REALTIME][OFFER_BOOKING_SMS_VALUE_REJECTED]", {
        callSid: bookingContext.callSid,
        stepKey: prepared.stepKey,
        targetSlot: prepared.targetSlot,
        candidateSource: candidate.source,
        candidateValue: candidate.value,
        rawTranscriptValue: prepared.rawTranscriptValue,
        modelValue: prepared.modelValue,
        effectiveConfirmationProtocolValue,
        reason: "OFFER_BOOKING_SMS_REQUIRES_EXPLICIT_YES_OR_NO",
      });

      return buildRealtimeStepRetryResult({
        error: "AMBIGUOUS_OFFER_BOOKING_SMS_VALUE",
        currentStep: prepared.currentStep,
        currentIndex: prepared.currentIndex,
        currentLocale: bookingContext.currentLocale,
        steps,
        bookingState,
      });
    }

    const fieldServiceValidation =
      await validateFieldServiceAddressStep({
        tenantId,
        callSid:
          bookingContext.callSid,
        currentLocale:
          bookingContext.currentLocale,

        currentStep:
          prepared.currentStep,
        currentIndex:
          prepared.currentIndex,
        stepKey:
          prepared.stepKey,
        targetSlot:
          prepared.targetSlot,
        resolvedInputValue:
          isCurrentConfirmationStep
            ? effectiveConfirmationProtocolValue
            : prepared.resolvedInputValue,

        state:
          bookingContext.state,
        steps,

        buildRealtimeBookingState,
        persistVoiceState,
      });

    if (fieldServiceValidation.handled) {
      if (
        fieldServiceValidation.cancelledState
      ) {
        Object.assign(
          bookingContext.state,
          fieldServiceValidation.cancelledState
        );
      }

      return fieldServiceValidation.result;
    }

    const resolvedInputValue =
      fieldServiceValidation.normalizedValue;

    const routeResult = await executeRealtimeStepRoute({
      tenantId,
      callerPhone,
      bookingContext,
      steps,
      currentStep: prepared.currentStep,
      currentIndex: prepared.currentIndex,
      targetSlot: prepared.targetSlot,
      stepKey: prepared.stepKey,
      resolvedInputValue,
      rawTranscriptValue: prepared.rawTranscriptValue,
      modelValue: prepared.modelValue,
      sanitizedArgs: {
        ...prepared.sanitizedArgs,
        resolved_candidate_source: candidate.source,
        value_candidates: candidates,
      },
      buildRealtimeBookingState,
      persistVoiceState,
    });

    if (routeResult.kind === "return") {
      lastRouteReturn = routeResult.result;

      if (shouldTryNextCandidate(routeResult.result)) {
        continue;
      }

      return routeResult.result;
    }

    const advanced = await advanceRealtimeBookingStep({
      tenantId,
      callerPhone,
      callSid: bookingContext.callSid,
      currentLocale: bookingContext.currentLocale,
      steps,
      currentIndex: prepared.currentIndex,
      workingState: routeResult.workingState,
      bookingContextState: bookingContext.state,
      buildRealtimeBookingState,
      persistVoiceState,
    });

    if (!advanced.ok) {
      return {
        ok: false,
        error: advanced.error,
        step_key: advanced.step_key,
        slot: advanced.slot,
        prompt_error: advanced.prompt_error,
        retry_prompt_error: advanced.retry_prompt_error,
        message: "BOOKING_FLOW_CONFIGURATION_INVALID",
        booking_state: advanced.booking_state,
        next_required_step: null,
      };
    }

    Object.assign(bookingContext.state, advanced.advancedState);

    return {
      ok: true,
      booking_state: advanced.booking_state,
      next_required_step: advanced.next_required_step,
      assistant_prompt: advanced.assistant_prompt,
      action_required: advanced.action_required,
      resolved_candidate_source: candidate.source,
    };
  }

  const retrySource = lastPreparedFailure || lastRouteReturn;

  if (
    retrySource?.ok === false &&
    retrySource?.currentStep &&
    typeof retrySource?.currentIndex === "number"
  ) {
    const bookingState = buildRealtimeBookingState({
      steps,
      state: bookingContext.state,
      explicitCurrentIndex: retrySource.currentIndex,
    });

    return buildRealtimeStepRetryResult({
      error: retrySource.error || "UNRESOLVED_BOOKING_STEP_VALUE",
      currentStep: retrySource.currentStep,
      currentIndex: retrySource.currentIndex,
      currentLocale: bookingContext.currentLocale,
      steps,
      bookingState,
    });
  }

  return (
    retrySource || {
      ok: false,
      error: "UNRESOLVED_BOOKING_STEP_VALUE",
      message:
        "None of the submitted value candidates could be resolved by the configured booking step.",
    }
  );
}