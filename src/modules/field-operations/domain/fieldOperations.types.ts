// src/modules/field-operations/domain/fieldOperations.types.ts

export type FieldOperationResourceType =
  | "person"
  | "crew"
  | "vehicle"
  | "equipment"
  | "other";

export type FieldOperationResource = {
  id: string;
  tenantId: string;

  name: string;
  resourceType: FieldOperationResourceType;

  externalProvider: string | null;
  externalReference: string | null;

  active: boolean;

  startAddress: string | null;
  startLatitude: number | null;
  startLongitude: number | null;

  endAddress: string | null;
  endLatitude: number | null;
  endLongitude: number | null;

  timezone: string | null;

  availability: Record<string, unknown>;
  capabilities: unknown[];
  metadata: Record<string, unknown>;

  createdAt: string;
  updatedAt: string;
};

export type AppointmentLocationType =
  | "service"
  | "pickup"
  | "dropoff"
  | "start"
  | "end"
  | "other";

export type AppointmentLocation = {
  id: string;
  tenantId: string;
  appointmentId: string;

  locationType: AppointmentLocationType;
  formattedAddress: string;
  addressComponents: Record<string, unknown>;

  latitude: number | null;
  longitude: number | null;

  geocodingProvider: string | null;
  providerPlaceId: string | null;
  geocodingStatus: string;
  geocodingError: string | null;

  metadata: Record<string, unknown>;

  createdAt: string;
  updatedAt: string;
};

export type RoutePlanMode =
  | "view_only"
  | "suggest"
  | "automatic";

export type RoutePlanStatus =
  | "draft"
  | "calculating"
  | "ready"
  | "failed"
  | "archived";

export type RoutePlan = {
  id: string;
  tenantId: string;
  resourceId: string;

  serviceDate: string;
  status: RoutePlanStatus;
  mode: RoutePlanMode;

  routingProvider: string | null;

  totalDistanceMeters: number;
  totalDriveSeconds: number;
  totalServiceSeconds: number;

  optimizationRequest: Record<string, unknown>;
  optimizationResult: Record<string, unknown>;
  providerMetadata: Record<string, unknown>;

  calculationStartedAt: string | null;
  calculationFinishedAt: string | null;

  errorCode: string | null;
  errorDetails: Record<string, unknown>;

  createdAt: string;
  updatedAt: string;
};

export type RouteStopInput = {
  appointmentId: string | null;
  locationId: string;

  latitude: number;
  longitude: number;

  serviceDurationSeconds: number;

  availableFrom: string | null;
  availableUntil: string | null;

  locked: boolean;

  metadata?: Record<string, unknown>;
};

export type RouteStopResult = {
  appointmentId: string | null;
  locationId: string;

  order: number;

  plannedArrivalAt: string | null;
  plannedDepartureAt: string | null;

  driveSecondsFromPrevious: number;
  distanceMetersFromPrevious: number;

  metadata: Record<string, unknown>;
};

export type RouteOptimizationInput = {
  tenantId: string;
  resourceId: string;
  serviceDate: string;

  startLocation: {
    latitude: number;
    longitude: number;
  } | null;

  endLocation: {
    latitude: number;
    longitude: number;
  } | null;

  stops: RouteStopInput[];

  options: Record<string, unknown>;
};

export type RouteOptimizationResult = {
  orderedStops: RouteStopResult[];

  totalDistanceMeters: number;
  totalDriveSeconds: number;
  totalServiceSeconds: number;

  provider: string;
  providerMetadata: Record<string, unknown>;
};