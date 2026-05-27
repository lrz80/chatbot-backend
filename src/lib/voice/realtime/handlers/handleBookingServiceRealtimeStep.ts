// src/lib/voice/realtime/handlers/handleBookingServiceRealtimeStep.ts

import type { CallState, VoiceLocale } from "../../types";
import type {
  BookingFlowStepLike,
  BookingState,
} from "../realtimeBookingFlowUtils";
import { resolveTenantBookingProvider } from "../../../appointments/booking/providers/resolveTenantBookingProvider";
import { handleSquareBookingServiceRealtimeStep } from "../../booking/services/square/handleSquareBookingServiceRealtimeStep";
import { handleDashboardBookingServiceRealtimeStep } from "../../booking/services/dashboard/handleDashboardBookingServiceRealtimeStep";
import { resolveBookingServiceProvider } from "../../booking/services/resolveBookingServiceProvider";

type HandleBookingServiceRealtimeStepParams = {
  tenantId: string;
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

type HandleBookingServiceRealtimeStepResult =
  | {
      kind: "return";
      result: any;
    }
  | {
      kind: "continue";
      workingState: CallState;
    };

export async function handleBookingServiceRealtimeStep(
  params: HandleBookingServiceRealtimeStepParams
): Promise<HandleBookingServiceRealtimeStepResult> {
  const {
    tenantId,
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

  const provider = await resolveBookingServiceProvider(tenantId);

  if (provider === "square") {
    return handleSquareBookingServiceRealtimeStep({
      tenantId,
      currentStep,
      currentIndex,
      currentLocale,
      value,
      targetSlot,
      stepKey,
      rawAnswers,
      workingState,
      steps,
      buildRealtimeBookingState,
    });
  }

  return handleDashboardBookingServiceRealtimeStep({
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
  });
}