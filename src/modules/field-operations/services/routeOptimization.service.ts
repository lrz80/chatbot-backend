// src/modules/field-operations/services/routeOptimization.service.ts

import {
  getRoutePlanById,
  markRoutePlanCalculating,
  markRoutePlanFailed,
  saveRoutePlanResult,
} from "../repositories/routePlans.repo";

import { getFieldOperationResourceById } from "../repositories/fieldResources.repo";

import { getRoutingProvider } from "../providers/routingProviderRegistry";

import type {
  RoutingOptimizationRequest,
  RoutingStopInput,
} from "../providers/routingProvider.types";

export type OptimizeRoutePlanInput = {
  tenantId: string;
  routePlanId: string;

  providerName?: string;

  routeStartAt?: string | null;

  stops: RoutingStopInput[];

  options?: RoutingOptimizationRequest["options"];

  metadata?: Record<string, unknown>;
};

function requiredString(
  value: unknown,
  fieldName: string
): string {
  const result = String(value ?? "").trim();

  if (!result) {
    throw new Error(
      `FIELD_OPERATIONS_REQUIRED_FIELD:${fieldName}`
    );
  }

  return result;
}

function serializeError(
  error: unknown
): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    message: String(error),
  };
}

export async function optimizeRoutePlan(
  input: OptimizeRoutePlanInput
) {
  const tenantId = requiredString(
    input.tenantId,
    "tenantId"
  );

  const routePlanId = requiredString(
    input.routePlanId,
    "routePlanId"
  );

  const routePlan = await getRoutePlanById({
    tenantId,
    routePlanId,
  });

  if (!routePlan) {
    throw new Error(
      "FIELD_OPERATIONS_ROUTE_PLAN_NOT_FOUND"
    );
  }

  const resource =
    await getFieldOperationResourceById({
      tenantId,
      resourceId: routePlan.resourceId,
    });

  if (!resource) {
    throw new Error(
      "FIELD_OPERATIONS_RESOURCE_NOT_FOUND"
    );
  }

  if (!resource.active) {
    throw new Error(
      "FIELD_OPERATIONS_RESOURCE_INACTIVE"
    );
  }

  const calculatingPlan =
    await markRoutePlanCalculating({
      tenantId,
      routePlanId,
    });

  if (!calculatingPlan) {
    throw new Error(
      "FIELD_OPERATIONS_ROUTE_PLAN_NOT_FOUND"
    );
  }

  try {
    const provider = getRoutingProvider(
      input.providerName
    );

    const response = await provider.optimize({
      tenantId,
      resourceId: resource.id,
      serviceDate: routePlan.serviceDate,

      startLocation:
        resource.startLatitude !== null &&
        resource.startLongitude !== null
          ? {
              latitude: resource.startLatitude,
              longitude: resource.startLongitude,
            }
          : null,

      endLocation:
        resource.endLatitude !== null &&
        resource.endLongitude !== null
          ? {
              latitude: resource.endLatitude,
              longitude: resource.endLongitude,
            }
          : null,

      routeStartAt: input.routeStartAt ?? null,

      stops: input.stops,

      options: input.options,

      metadata: {
        ...input.metadata,
        routePlanId,
        routePlanMode: routePlan.mode,
      },
    });

    return await saveRoutePlanResult({
      tenantId,
      routePlanId,
      status: "ready",
      result: {
        provider: response.provider,
        orderedStops: response.orderedStops,
        totalDistanceMeters:
          response.totalDistanceMeters,
        totalDriveSeconds: response.totalDriveSeconds,
        totalServiceSeconds:
          response.totalServiceSeconds,
        providerMetadata: response.providerMetadata,
      },
    });
  } catch (error) {
    await markRoutePlanFailed({
      tenantId,
      routePlanId,
      errorCode:
        error instanceof Error
          ? error.message.split(":")[0]
          : "FIELD_OPERATIONS_ROUTE_OPTIMIZATION_FAILED",
      errorDetails: serializeError(error),
    });

    throw error;
  }
}