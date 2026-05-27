// src/lib/voice/booking/services/square/applyResolvedSquareService.ts

import type { CallState } from "../../../types";
import type { SquareBookableService } from "../../../../integrations/square/getSquareBookableServices";
import { upsertTenantExternalServiceMapping } from "../../../../integrations/serviceMappings/getTenantExternalServiceMapping";
import { buildCanonicalCallState } from "../../../realtime/realtimeBookingFlowUtils";
import { clearPendingSquareServiceChoice } from "./squareServiceChoiceState";

type ApplyResolvedSquareServiceParams = {
  tenantId: string;
  connection: any;
  currentIndex: number;
  rawAnswers: Record<string, string>;
  workingState: CallState;
  targetSlot: string;
  stepKey: string;
  input: string;
  service: SquareBookableService;
  serviceName: string;
  score: number;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export async function applyResolvedSquareService(
  params: ApplyResolvedSquareServiceParams
): Promise<CallState> {
  const {
    tenantId,
    connection,
    currentIndex,
    rawAnswers,
    workingState,
    targetSlot,
    stepKey,
    input,
    service,
    serviceName,
    score,
  } = params;

  await upsertTenantExternalServiceMapping({
    tenantId,
    provider: "square",
    internalServiceKey: serviceName,
    externalServiceId: service.variationId,
    externalServiceVersion: service.variationVersion,
    externalLocationId: clean(connection?.locationId) || null,
    externalMetadata: {
      source: "square_catalog",
      itemId: service.itemId,
      itemName: service.itemName,
      variationName: service.variationName,
      durationMinutes: service.durationMinutes,
      availableForBooking: service.availableForBooking,
      resolvedFromInput: input,
      matchScore: score,
    },
    isActive: true,
  });

  const nextAnswers = {
    ...rawAnswers,
    [targetSlot]: serviceName,
    [stepKey]: serviceName,
  };

  const nextState = buildCanonicalCallState({
    state: clearPendingSquareServiceChoice(workingState),
    answersBySlot: nextAnswers,
    bookingStepIndex: currentIndex,
  }) as any;

  nextState.squareService = {
    provider: "square",
    serviceName,
    itemId: service.itemId,
    itemName: service.itemName,
    variationId: service.variationId,
    variationName: service.variationName,
    variationVersion: service.variationVersion,
    durationMinutes: service.durationMinutes,
  };

  return nextState as CallState;
}