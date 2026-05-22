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
  const rawCandidates = Array.isArray(args.value_candidates)
    ? args.value_candidates
    : [];

  const candidatesFromArgs = rawCandidates
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

  const legacyValue = clean(args.value);

  const candidates: SubmitValueCandidate[] =
    candidatesFromArgs.length > 0
      ? candidatesFromArgs
      : legacyValue
      ? [
          {
            source: "legacy",
            value: legacyValue,
          },
        ]
      : [];

  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    const key = `${candidate.source}:${candidate.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildArgsForCandidate(params: {
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

  /**
   * If the route explicitly succeeded, stop.
   */
  if (result.ok === true) return false;

  /**
   * If the route failed while resolving/validating the submitted value,
   * another candidate may still resolve through the official step resolver.
   *
   * This is not semantic hardcode. It does not inspect phrases, languages,
   * tenants, services, staff names, or business rules.
   */
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

  const fallbackPrepared = prepareRealtimeStepSubmission({
    callerPhone,
    args,
    bookingContext,
    steps,
    buildRealtimeBookingState,
  });

  if (!fallbackPrepared.ok) {
    if (
      fallbackPrepared.result?.ok === false &&
      fallbackPrepared.result?.currentStep &&
      typeof fallbackPrepared.result?.currentIndex === "number"
    ) {
      const bookingState = buildRealtimeBookingState({
        steps,
        state: bookingContext.state,
        explicitCurrentIndex: fallbackPrepared.result.currentIndex,
      });

      return buildRealtimeStepRetryResult({
        error: fallbackPrepared.result.error,
        currentStep: fallbackPrepared.result.currentStep,
        currentIndex: fallbackPrepared.result.currentIndex,
        currentLocale: bookingContext.currentLocale,
        steps,
        bookingState,
      });
    }

    return fallbackPrepared.result;
  }

  const candidatesToTry =
    candidates.length > 0
      ? candidates
      : [
          {
            source: "prepared",
            value: fallbackPrepared.resolvedInputValue,
          },
        ];

  let lastReturnResult: any = null;

  for (const candidate of candidatesToTry) {
    const candidateArgs = buildArgsForCandidate({
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
      lastReturnResult = prepared.result;
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
        value_candidates: candidatesToTry,
      },
      buildRealtimeBookingState,
      persistVoiceState,
    });

    if (routeResult.kind === "return") {
      lastReturnResult = routeResult.result;

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

  if (
    lastReturnResult?.ok === false &&
    lastReturnResult?.currentStep &&
    typeof lastReturnResult?.currentIndex === "number"
  ) {
    const bookingState = buildRealtimeBookingState({
      steps,
      state: bookingContext.state,
      explicitCurrentIndex: lastReturnResult.currentIndex,
    });

    return buildRealtimeStepRetryResult({
      error: lastReturnResult.error,
      currentStep: lastReturnResult.currentStep,
      currentIndex: lastReturnResult.currentIndex,
      currentLocale: bookingContext.currentLocale,
      steps,
      bookingState,
    });
  }

  return (
    lastReturnResult || {
      ok: false,
      error: "UNRESOLVED_BOOKING_STEP_VALUE",
      message:
        "None of the submitted value candidates could be resolved by the configured booking step.",
      booking_state: buildRealtimeBookingState({
        steps,
        state: bookingContext.state,
        explicitCurrentIndex: fallbackPrepared.currentIndex,
      }),
      next_required_step: buildRealtimeStepRetryResult({
        error: "UNRESOLVED_BOOKING_STEP_VALUE",
        currentStep: fallbackPrepared.currentStep,
        currentIndex: fallbackPrepared.currentIndex,
        currentLocale: bookingContext.currentLocale,
        steps,
        bookingState: buildRealtimeBookingState({
          steps,
          state: bookingContext.state,
          explicitCurrentIndex: fallbackPrepared.currentIndex,
        }),
      }).next_required_step,
    }
  );
}