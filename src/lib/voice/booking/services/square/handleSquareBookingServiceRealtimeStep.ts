// src/lib/voice/booking/services/square/handleSquareBookingServiceRealtimeStep.ts

import type { CallState, VoiceLocale } from "../../../types";
import type {
  BookingFlowStepLike,
  BookingState,
} from "../../../realtime/realtimeBookingFlowUtils";
import { getSquareConnectionForTenant } from "../../../../integrations/square/getSquareConnectionForTenant";
import { getSquareBookableServices } from "../../../../integrations/square/getSquareBookableServices";
import {
  getSquareServiceName,
  resolveSquareServiceChoiceFromInput,
  resolveSquareServiceFromInput,
} from "./squareServiceMatcher";
import {
  getPendingSquareServiceChoice,
  setPendingSquareServiceChoice,
} from "./squareServiceChoiceState";
import { applyResolvedSquareService } from "./applyResolvedSquareService";
import { buildBookingServiceRetryResult } from "../buildBookingServiceRetryResult";
import { getLocalizedBookingStepPrompt } from "../getLocalizedBookingStepPrompt";

type HandleSquareBookingServiceRealtimeStepParams = {
  tenantId: string;
  currentStep: BookingFlowStepLike;
  currentIndex: number;
  currentLocale: VoiceLocale;
  value: string;
  targetSlot: string;
  stepKey: string;
  rawAnswers: Record<string, string>;
  workingState: CallState;
  steps: BookingFlowStepLike[];
  buildRealtimeBookingState: (params: {
    steps: BookingFlowStepLike[];
    state: CallState;
    explicitCurrentIndex?: number | null;
    finalConfirmationGranted?: boolean;
    readyToCreate?: boolean;
  }) => BookingState;
};

export type HandleSquareBookingServiceRealtimeStepResult =
  | {
      kind: "return";
      result: any;
    }
  | {
      kind: "continue";
      workingState: CallState;
    };

export async function handleSquareBookingServiceRealtimeStep(
  params: HandleSquareBookingServiceRealtimeStepParams
): Promise<HandleSquareBookingServiceRealtimeStepResult> {
  const {
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
  } = params;

  const connectionResult = await getSquareConnectionForTenant(tenantId);

  if (!connectionResult.ok) {
    const prompt = getLocalizedBookingStepPrompt({
      step: currentStep,
      locale: currentLocale,
      field: "retry_prompt",
    })

    return buildBookingServiceRetryResult({
      error: "SQUARE_CONNECTION_NOT_AVAILABLE",
      prompt,
      currentStep,
      currentIndex,
      currentLocale,
      workingState,
      steps,
      serviceOptions: [],
      buildRealtimeBookingState,
    });
  }

  const pendingChoice = getPendingSquareServiceChoice(workingState);

  if (pendingChoice) {
    const selected = resolveSquareServiceChoiceFromInput({
      input: value,
      options: pendingChoice.options,
    });

    if (selected.kind === "resolved") {
      const nextState = await applyResolvedSquareService({
        tenantId,
        connection: connectionResult.connection,
        currentIndex,
        rawAnswers,
        workingState,
        targetSlot,
        stepKey,
        input: value,
        service: selected.service,
        serviceName: selected.serviceName,
        score: selected.score,
      });

      return {
        kind: "continue",
        workingState: nextState,
      };
    }

    const stateForRetry =
      selected.kind === "ambiguous"
        ? setPendingSquareServiceChoice({
            state: workingState,
            input: value,
            options: selected.options,
          })
        : workingState;

    const prompt = getLocalizedBookingStepPrompt({
      step: currentStep,
      locale: currentLocale,
      field: "retry_prompt",
    })

    return buildBookingServiceRetryResult({
      error:
        selected.kind === "ambiguous"
          ? "AMBIGUOUS_BOOKING_SERVICE"
          : "UNRESOLVED_BOOKING_SERVICE_CHOICE",
      prompt,
      currentStep,
      currentIndex,
      currentLocale,
      workingState: stateForRetry,
      steps,
      serviceOptions:
        selected.kind === "ambiguous"
          ? selected.options.map((service) => getSquareServiceName(service))
          : pendingChoice.options.map((service) => getSquareServiceName(service)),
      buildRealtimeBookingState,
    });
  }

  const servicesResult = await getSquareBookableServices({
    accessToken: connectionResult.connection.accessToken,
    environment: connectionResult.connection.environment,
  });

  if (!servicesResult.ok) {
    const prompt = getLocalizedBookingStepPrompt({
      step: currentStep,
      locale: currentLocale,
      field: "retry_prompt",
    })

    return buildBookingServiceRetryResult({
      error: servicesResult.error,
      prompt,
      currentStep,
      currentIndex,
      currentLocale,
      workingState,
      steps,
      serviceOptions: [],
      buildRealtimeBookingState,
    });
  }

  console.log("[BOOKING][SQUARE_SERVICES_LOADED_FOR_MATCH]", {
    tenantId,
    input: value,
    serviceCount: servicesResult.services.length,
    sample: servicesResult.services.slice(0, 8).map((service) => ({
      serviceName: getSquareServiceName(service),
      durationMinutes: service.durationMinutes,
      availableForBooking: service.availableForBooking,
    })),
  });

  const match = resolveSquareServiceFromInput({
    input: value,
    services: servicesResult.services,
    debug: true,
  });

  if (match.kind === "resolved") {
    const nextState = await applyResolvedSquareService({
      tenantId,
      connection: connectionResult.connection,
      currentIndex,
      rawAnswers,
      workingState,
      targetSlot,
      stepKey,
      input: value,
      service: match.service,
      serviceName: match.serviceName,
      score: match.score,
    });

    return {
      kind: "continue",
      workingState: nextState,
    };
  }

  const stateForRetry =
    match.kind === "ambiguous"
      ? setPendingSquareServiceChoice({
          state: workingState,
          input: value,
          options: match.options,
        })
      : workingState;

  const prompt = getLocalizedBookingStepPrompt({
    step: currentStep,
    locale: currentLocale,
    field: "retry_prompt",
  })

  return buildBookingServiceRetryResult({
    error:
      match.kind === "ambiguous"
        ? "AMBIGUOUS_BOOKING_SERVICE"
        : "UNRESOLVED_BOOKING_SERVICE",
    prompt,
    currentStep,
    currentIndex,
    currentLocale,
    workingState: stateForRetry,
    steps,
    serviceOptions:
      match.kind === "ambiguous"
        ? match.options.map((service) => getSquareServiceName(service))
        : servicesResult.services
            .slice(0, 8)
            .map((service) => getSquareServiceName(service))
            .filter(Boolean),
    buildRealtimeBookingState,
  });
}