// src/modules/field-operations/providers/geography.ts

import type { RoutingCoordinate } from "./routingProvider.types";

const EARTH_RADIUS_METERS = 6_371_000;

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function assertValidCoordinate(
  coordinate: RoutingCoordinate,
  fieldName: string
): void {
  if (
    !Number.isFinite(coordinate.latitude) ||
    coordinate.latitude < -90 ||
    coordinate.latitude > 90
  ) {
    throw new Error(
      `FIELD_OPERATIONS_INVALID_COORDINATE:${fieldName}.latitude`
    );
  }

  if (
    !Number.isFinite(coordinate.longitude) ||
    coordinate.longitude < -180 ||
    coordinate.longitude > 180
  ) {
    throw new Error(
      `FIELD_OPERATIONS_INVALID_COORDINATE:${fieldName}.longitude`
    );
  }
}

export function calculateHaversineDistanceMeters(
  from: RoutingCoordinate,
  to: RoutingCoordinate
): number {
  assertValidCoordinate(from, "from");
  assertValidCoordinate(to, "to");

  const latitude1 = degreesToRadians(from.latitude);
  const latitude2 = degreesToRadians(to.latitude);

  const latitudeDelta = degreesToRadians(
    to.latitude - from.latitude
  );

  const longitudeDelta = degreesToRadians(
    to.longitude - from.longitude
  );

  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) *
      Math.cos(latitude2) *
      Math.sin(longitudeDelta / 2) ** 2;

  const angularDistance =
    2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));

  return Math.round(EARTH_RADIUS_METERS * angularDistance);
}

export function estimateDriveSeconds(input: {
  distanceMeters: number;
  averageSpeedKph: number;
}): number {
  if (
    !Number.isFinite(input.distanceMeters) ||
    input.distanceMeters < 0
  ) {
    throw new Error(
      "FIELD_OPERATIONS_INVALID_DISTANCE_METERS"
    );
  }

  if (
    !Number.isFinite(input.averageSpeedKph) ||
    input.averageSpeedKph <= 0
  ) {
    throw new Error(
      "FIELD_OPERATIONS_INVALID_AVERAGE_SPEED"
    );
  }

  const metersPerSecond =
    (input.averageSpeedKph * 1_000) / 3_600;

  return Math.round(input.distanceMeters / metersPerSecond);
}