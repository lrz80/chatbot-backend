// src/modules/field-operations/providers/routingProvider.types.ts

export type RoutingCoordinate = {
  latitude: number;
  longitude: number;
};

export type RoutingStopInput = {
  appointmentId: string | null;
  locationId: string;

  latitude: number;
  longitude: number;

  serviceDurationSeconds: number;

  scheduledStartAt?: string | null;
  scheduledEndAt?: string | null;

  isLocked?: boolean;

  metadata?: Record<string, unknown>;
};

export type RoutingOptimizationRequest = {
  tenantId: string;
  resourceId: string;
  serviceDate: string;

  startLocation?: RoutingCoordinate | null;
  endLocation?: RoutingCoordinate | null;

  routeStartAt?: string | null;

  stops: RoutingStopInput[];

  options?: {
    preserveScheduledOrder?: boolean;
    returnToStart?: boolean;
    averageSpeedKph?: number;
  };

  metadata?: Record<string, unknown>;
};

export type RoutingStopOutput = {
  appointmentId: string | null;
  locationId: string;

  order: number;

  plannedArrivalAt: string | null;
  plannedDepartureAt: string | null;

  serviceDurationSeconds: number;
  driveSecondsFromPrevious: number;
  distanceMetersFromPrevious: number;

  metadata: Record<string, unknown>;
};

export type RoutingOptimizationResponse = {
  provider: string;

  orderedStops: RoutingStopOutput[];

  totalDistanceMeters: number;
  totalDriveSeconds: number;
  totalServiceSeconds: number;

  providerMetadata: Record<string, unknown>;
};

export interface RoutingProvider {
  readonly name: string;

  optimize(
    request: RoutingOptimizationRequest
  ): Promise<RoutingOptimizationResponse>;
}