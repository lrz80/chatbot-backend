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

function buildSubmitValueCandidates(args: Record<string, any>): SubmitValueCandidate[] {
  const primaryValue = clean(args.value);
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

  /**
   * args.value is already the server-selected value from realtimeToolCallHandler.
   * Do not let raw transcript candidates override it again here.
   */
  const orderedCandidates: SubmitValueCandidate[] = [
    primaryValue
      ? {
          source: clean(args.resolved_candidate_source) || "selected",
          value: primaryValue,
        }
      : null,
    ...parsedCandidates,
  ].filter(Boolean) as SubmitValueCandidate[];

  const seen = new Set<string>();

  return orderedCandidates.filter((candidate) => {
    const normalizedValue = candidate.value.toLowerCase();
    const key = normalizedValue;

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

  const candidates = buildSubmitValueCandidates(args);

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

    const routeResult = await executeRealtimeStepRoute({
      tenantId,
      callerPhone,
      bookingContext,
      steps,
      currentStep: prepared.currentStep,
      currentIndex: prepared.currentIndex,
      targetSlot: prepared.targetSlot,
      stepKey: prepared.stepKey,
      resolvedInputValue: prepared.resolvedInputValue,
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