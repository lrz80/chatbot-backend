// src/lib/voice/booking/services/dashboard/handleDashboardBookingServiceRealtimeStep.ts

import type { CallState, VoiceLocale } from "../../../types";
import { executeCanonicalBookingServiceStep } from "../../handleBookingServiceStep";
import {
  buildCanonicalCallState,
  type BookingFlowStepLike,
  type BookingState,
} from "../../../realtime/realtimeBookingFlowUtils";
import { buildBookingServiceRetryResult } from "../buildBookingServiceRetryResult";

type HandleDashboardBookingServiceRealtimeStepParams = {
  callerPhone: string | null;
  currentStep: BookingFlowStepLike;
  currentIndex: number;
  currentLocale: VoiceLocale;
  value: string;
  targetSlot: string;
  stepKey: string;
  rawAnswers: Record<string, string>;
  workingState: CallState;
  rawConfig: string;
  steps: BookingFlowStepLike[];
  buildRealtimeBookingState: (params: {
    steps: BookingFlowStepLike[];
    state: CallState;
    explicitCurrentIndex?: number | null;
    finalConfirmationGranted?: boolean;
    readyToCreate?: boolean;
  }) => BookingState;
};

export type HandleDashboardBookingServiceRealtimeStepResult =
  | {
      kind: "return";
      result: any;
    }
  | {
      kind: "continue";
      workingState: CallState;
    };

export async function handleDashboardBookingServiceRealtimeStep(
  params: HandleDashboardBookingServiceRealtimeStepParams
): Promise<HandleDashboardBookingServiceRealtimeStepResult> {
  const {
    callerPhone,
    currentStep,
    currentIndex,
    currentLocale,
    value,
    targetSlot,
    stepKey,
    rawAnswers,
    workingState,
    rawConfig,
    steps,
    buildRealtimeBookingState,
  } = params;

  const serviceResult = await executeCanonicalBookingServiceStep({
    currentStep: currentStep as any,
    currentLocale,
    callerE164: callerPhone,
    effectiveUserInput: value,
    state: workingState,
    rawConfig,
  });

  if (serviceResult.kind === "retry" || serviceResult.kind === "ambiguous") {
    return buildBookingServiceRetryResult({
      error:
        serviceResult.kind === "ambiguous"
          ? "AMBIGUOUS_BOOKING_SERVICE"
          : "UNRESOLVED_BOOKING_SERVICE",
      prompt: serviceResult.prompt,
      currentStep,
      currentIndex,
      currentLocale,
      workingState,
      steps,
      serviceOptions:
        serviceResult.kind === "ambiguous" ? serviceResult.options : [],
      buildRealtimeBookingState,
    });
  }

  const nextAnswers = {
    ...rawAnswers,
    [targetSlot]: serviceResult.resolvedValue,
    [stepKey]: serviceResult.resolvedValue,
  };

  return {
    kind: "continue",
    workingState: buildCanonicalCallState({
      state: serviceResult.state,
      answersBySlot: nextAnswers,
      bookingStepIndex: currentIndex,
    }),
  };
}