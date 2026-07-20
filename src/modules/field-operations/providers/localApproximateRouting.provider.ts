// src/modules/field-operations/providers/localApproximateRouting.provider.ts

import {
  calculateHaversineDistanceMeters,
  estimateDriveSeconds,
} from "./geography";

import type {
  RoutingCoordinate,
  RoutingOptimizationRequest,
  RoutingOptimizationResponse,
  RoutingProvider,
  RoutingStopInput,
  RoutingStopOutput,
} from "./routingProvider.types";

type StopWithOriginalIndex = RoutingStopInput & {
  originalIndex: number;
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

function nonNegativeInteger(
  value: unknown,
  fieldName: string
): number {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      `FIELD_OPERATIONS_INVALID_NON_NEGATIVE_INTEGER:${fieldName}`
    );
  }

  return parsed;
}

function parseIsoTimestampOrNull(
  value: unknown,
  fieldName: string
): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = new Date(String(value));

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `FIELD_OPERATIONS_INVALID_TIMESTAMP:${fieldName}`
    );
  }

  return parsed.toISOString();
}

function addSeconds(
  timestamp: string | null,
  seconds: number
): string | null {
  if (!timestamp) {
    return null;
  }

  const parsed = new Date(timestamp);

  return new Date(
    parsed.getTime() + seconds * 1_000
  ).toISOString();
}

function maxTimestamp(
  first: string | null,
  second: string | null
): string | null {
  if (!first) return second;
  if (!second) return first;

  const firstTime = new Date(first).getTime();
  const secondTime = new Date(second).getTime();

  if (
    Number.isNaN(firstTime) ||
    Number.isNaN(secondTime)
  ) {
    return first;
  }

  return firstTime >= secondTime
    ? first
    : second;
}

function coordinateFromStop(
  stop: RoutingStopInput
): RoutingCoordinate {
  return {
    latitude: stop.latitude,
    longitude: stop.longitude,
  };
}

function compareScheduledStops(
  first: StopWithOriginalIndex,
  second: StopWithOriginalIndex
): number {
  const firstTimestamp = first.scheduledStartAt
    ? new Date(first.scheduledStartAt).getTime()
    : Number.POSITIVE_INFINITY;

  const secondTimestamp = second.scheduledStartAt
    ? new Date(second.scheduledStartAt).getTime()
    : Number.POSITIVE_INFINITY;

  if (firstTimestamp !== secondTimestamp) {
    return firstTimestamp - secondTimestamp;
  }

  return first.originalIndex - second.originalIndex;
}

function orderByNearestNeighbor(input: {
  stops: StopWithOriginalIndex[];
  startLocation: RoutingCoordinate | null;
}): StopWithOriginalIndex[] {
  const remaining = [...input.stops];
  const ordered: StopWithOriginalIndex[] = [];

  let currentLocation =
    input.startLocation ??
    (remaining[0] ? coordinateFromStop(remaining[0]) : null);

  while (remaining.length > 0) {
    if (!currentLocation) {
      ordered.push(...remaining);
      break;
    }

    let selectedIndex = 0;
    let selectedDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];

      const distance = calculateHaversineDistanceMeters(
        currentLocation,
        coordinateFromStop(candidate)
      );

      if (distance < selectedDistance) {
        selectedDistance = distance;
        selectedIndex = index;
        continue;
      }

      if (
        distance === selectedDistance &&
        candidate.originalIndex <
          remaining[selectedIndex].originalIndex
      ) {
        selectedIndex = index;
      }
    }

    const [selected] = remaining.splice(selectedIndex, 1);

    ordered.push(selected);
    currentLocation = coordinateFromStop(selected);
  }

  return ordered;
}

function validateAndNormalizeStops(
  stops: RoutingStopInput[]
): StopWithOriginalIndex[] {
  const seenLocationIds = new Set<string>();

  return stops.map((stop, index) => {
    const locationId = requiredString(
      stop.locationId,
      `stops[${index}].locationId`
    );

    if (seenLocationIds.has(locationId)) {
      throw new Error(
        `FIELD_OPERATIONS_DUPLICATE_LOCATION:${locationId}`
      );
    }

    seenLocationIds.add(locationId);

    if (
      !Number.isFinite(stop.latitude) ||
      stop.latitude < -90 ||
      stop.latitude > 90
    ) {
      throw new Error(
        `FIELD_OPERATIONS_INVALID_COORDINATE:stops[${index}].latitude`
      );
    }

    if (
      !Number.isFinite(stop.longitude) ||
      stop.longitude < -180 ||
      stop.longitude > 180
    ) {
      throw new Error(
        `FIELD_OPERATIONS_INVALID_COORDINATE:stops[${index}].longitude`
      );
    }

    return {
      ...stop,
      locationId,
      serviceDurationSeconds: nonNegativeInteger(
        stop.serviceDurationSeconds,
        `stops[${index}].serviceDurationSeconds`
      ),
      scheduledStartAt: parseIsoTimestampOrNull(
        stop.scheduledStartAt,
        `stops[${index}].scheduledStartAt`
      ),
      scheduledEndAt: parseIsoTimestampOrNull(
        stop.scheduledEndAt,
        `stops[${index}].scheduledEndAt`
      ),
      metadata: stop.metadata ?? {},
      originalIndex: index,
    };
  });
}

export class LocalApproximateRoutingProvider
  implements RoutingProvider
{
  readonly name = "local_approximate";

  async optimize(
    request: RoutingOptimizationRequest
  ): Promise<RoutingOptimizationResponse> {
    requiredString(request.tenantId, "tenantId");
    requiredString(request.resourceId, "resourceId");
    requiredString(request.serviceDate, "serviceDate");

    const stops = validateAndNormalizeStops(request.stops);

    if (stops.length === 0) {
      return {
        provider: this.name,
        orderedStops: [],
        totalDistanceMeters: 0,
        totalDriveSeconds: 0,
        totalServiceSeconds: 0,
        providerMetadata: {
          calculationType: "approximate",
          algorithm: "nearest_neighbor",
          usesRoadNetwork: false,
          usesLiveTraffic: false,
        },
      };
    }

    const averageSpeedKph =
      request.options?.averageSpeedKph ?? 35;

    if (
      !Number.isFinite(averageSpeedKph) ||
      averageSpeedKph <= 0
    ) {
      throw new Error(
        "FIELD_OPERATIONS_INVALID_AVERAGE_SPEED"
      );
    }

    const preserveScheduledOrder =
      request.options?.preserveScheduledOrder ?? false;

    const orderedInputStops = preserveScheduledOrder
      ? [...stops].sort(compareScheduledStops)
      : orderByNearestNeighbor({
          stops,
          startLocation: request.startLocation ?? null,
        });

    const orderedStops: RoutingStopOutput[] = [];

    let previousCoordinate =
      request.startLocation ??
      coordinateFromStop(orderedInputStops[0]);

    let currentTimestamp = parseIsoTimestampOrNull(
      request.routeStartAt,
      "routeStartAt"
    );

    let totalDistanceMeters = 0;
    let totalDriveSeconds = 0;
    let totalServiceSeconds = 0;

    for (
      let index = 0;
      index < orderedInputStops.length;
      index += 1
    ) {
      const stop = orderedInputStops[index];
      const stopCoordinate = coordinateFromStop(stop);

      const isFirstStopWithoutStart =
        index === 0 && !request.startLocation;

      const distanceMetersFromPrevious =
        isFirstStopWithoutStart
          ? 0
          : calculateHaversineDistanceMeters(
              previousCoordinate,
              stopCoordinate
            );

      const driveSecondsFromPrevious =
        isFirstStopWithoutStart
          ? 0
          : estimateDriveSeconds({
              distanceMeters: distanceMetersFromPrevious,
              averageSpeedKph,
            });

      const physicalArrivalAt = addSeconds(
        currentTimestamp,
        driveSecondsFromPrevious
      );

      const plannedArrivalAt = maxTimestamp(
        physicalArrivalAt,
        stop.scheduledStartAt ?? null
      );

      const plannedDepartureAt = addSeconds(
        plannedArrivalAt,
        stop.serviceDurationSeconds
      );

      orderedStops.push({
        appointmentId: stop.appointmentId,
        locationId: stop.locationId,

        order: index,

        plannedArrivalAt,
        plannedDepartureAt,

        serviceDurationSeconds:
          stop.serviceDurationSeconds,

        driveSecondsFromPrevious,
        distanceMetersFromPrevious,

        metadata: {
          ...stop.metadata,
          scheduledStartAt: stop.scheduledStartAt ?? null,
          scheduledEndAt: stop.scheduledEndAt ?? null,
          isLocked: stop.isLocked ?? false,
          sourceOrder: stop.originalIndex,

          physicalArrivalAt,

          waitingSeconds:
            physicalArrivalAt &&
            plannedArrivalAt
              ? Math.max(
                  0,
                  Math.round(
                    (
                      new Date(plannedArrivalAt).getTime() -
                      new Date(physicalArrivalAt).getTime()
                    ) / 1000
                  )
                )
              : 0,
          },
      });

      totalDistanceMeters += distanceMetersFromPrevious;
      totalDriveSeconds += driveSecondsFromPrevious;
      totalServiceSeconds += stop.serviceDurationSeconds;

      currentTimestamp = plannedDepartureAt;
      previousCoordinate = stopCoordinate;
    }

    if (
      request.options?.returnToStart &&
      request.startLocation &&
      orderedInputStops.length > 0
    ) {
      const distanceBackToStart =
        calculateHaversineDistanceMeters(
          previousCoordinate,
          request.startLocation
        );

      const driveSecondsBackToStart =
        estimateDriveSeconds({
          distanceMeters: distanceBackToStart,
          averageSpeedKph,
        });

      totalDistanceMeters += distanceBackToStart;
      totalDriveSeconds += driveSecondsBackToStart;
    } else if (
      request.endLocation &&
      orderedInputStops.length > 0
    ) {
      const distanceToEnd =
        calculateHaversineDistanceMeters(
          previousCoordinate,
          request.endLocation
        );

      const driveSecondsToEnd =
        estimateDriveSeconds({
          distanceMeters: distanceToEnd,
          averageSpeedKph,
        });

      totalDistanceMeters += distanceToEnd;
      totalDriveSeconds += driveSecondsToEnd;
    }

    return {
      provider: this.name,
      orderedStops,
      totalDistanceMeters,
      totalDriveSeconds,
      totalServiceSeconds,
      providerMetadata: {
        calculationType: "approximate",
        algorithm: preserveScheduledOrder
          ? "scheduled_order"
          : "nearest_neighbor",
        usesRoadNetwork: false,
        usesLiveTraffic: false,
        averageSpeedKph,
        returnToStart:
          request.options?.returnToStart ?? false,
      },
    };
  }
}