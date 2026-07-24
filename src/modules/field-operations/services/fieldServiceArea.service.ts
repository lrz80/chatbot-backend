// src/modules/field-operations/services/fieldServiceArea.service.ts

import pool from "../../../lib/db";

import {
  googleMapsGeocodingProvider,
} from "../providers/googleMapsGeocoding.provider";

export type FieldServiceAreaSettings = {
  enabled: boolean;
  baseAddress: string | null;
  baseLatitude: number | null;
  baseLongitude: number | null;
  radiusMiles: number | null;
};

export type FieldServiceAreaValidationResult = {
  allowed: boolean;
  validationApplied: boolean;

  reason:
    | null
    | "FIELD_SERVICE_AREA_DISABLED"
    | "FIELD_SERVICE_AREA_NOT_CONFIGURED"
    | "FIELD_SERVICE_LOCATION_OUTSIDE_RADIUS";

  distanceMiles: number | null;
  radiusMiles: number | null;
};

export type GeocodeFieldServiceBaseAddressResult = {
  formattedAddress: string;
  latitude: number;
  longitude: number;

  placeId: string | null;
  partialMatch: boolean;
  locationType: string | null;

  addressComponents: Array<{
    longName: string;
    shortName: string;
    types: string[];
  }>;
};

function parseCoordinate(
  value: unknown,
  minimum: number,
  maximum: number
): number | null {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const parsed = Number(value);

  if (
    !Number.isFinite(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    return null;
  }

  return parsed;
}

function toRadians(value: number): number {
  return value * Math.PI / 180;
}

function calculateDistanceMiles(params: {
  fromLatitude: number;
  fromLongitude: number;
  toLatitude: number;
  toLongitude: number;
}): number {
  const earthRadiusMiles = 3958.7613;

  const latitudeDelta = toRadians(
    params.toLatitude - params.fromLatitude
  );

  const longitudeDelta = toRadians(
    params.toLongitude - params.fromLongitude
  );

  const fromLatitudeRadians =
    toRadians(params.fromLatitude);

  const toLatitudeRadians =
    toRadians(params.toLatitude);

  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitudeRadians) *
      Math.cos(toLatitudeRadians) *
      Math.sin(longitudeDelta / 2) ** 2;

  const centralAngle =
    2 * Math.atan2(
      Math.sqrt(haversine),
      Math.sqrt(1 - haversine)
    );

  return earthRadiusMiles * centralAngle;
}

export async function getFieldServiceAreaSettings(
  tenantId: string
): Promise<FieldServiceAreaSettings> {
  const { rows } = await pool.query(
    `
    SELECT
      field_service_area_enabled,
      field_service_base_address,
      field_service_base_latitude,
      field_service_base_longitude,
      field_service_radius_miles
    FROM appointment_settings
    WHERE tenant_id = $1
    LIMIT 1
    `,
    [tenantId]
  );

  const row = rows[0];

  return {
    enabled:
      row?.field_service_area_enabled === true,

    baseAddress:
      String(
        row?.field_service_base_address ?? ""
      ).trim() || null,

    baseLatitude: parseCoordinate(
      row?.field_service_base_latitude,
      -90,
      90
    ),

    baseLongitude: parseCoordinate(
      row?.field_service_base_longitude,
      -180,
      180
    ),

    radiusMiles: (() => {
      const parsed = Number(
        row?.field_service_radius_miles
      );

      return Number.isFinite(parsed) && parsed > 0
        ? parsed
        : null;
    })(),
  };
}

export async function geocodeFieldServiceBaseAddress(
  params: {
    address: string;
    language?: string;
    region?: string;
  }
): Promise<GeocodeFieldServiceBaseAddressResult> {
  const address = String(
    params.address ?? ""
  ).trim();

  if (!address) {
    throw new Error(
      "FIELD_SERVICE_BASE_ADDRESS_REQUIRED"
    );
  }

  const geocoding =
    await googleMapsGeocodingProvider.geocode({
      address,
      language: params.language,
      region: params.region,
    });

  if (!geocoding) {
    throw new Error(
      "FIELD_SERVICE_BASE_ADDRESS_NOT_FOUND"
    );
  }

  return {
    formattedAddress:
      geocoding.formattedAddress,

    latitude:
      geocoding.latitude,

    longitude:
      geocoding.longitude,

    placeId:
      geocoding.placeId,

    partialMatch:
      geocoding.partialMatch,

    locationType:
      geocoding.locationType,

    addressComponents:
      geocoding.addressComponents,
  };
}

export async function validateFieldServiceArea(
  params: {
    tenantId: string;
    latitude: number;
    longitude: number;
  }
): Promise<FieldServiceAreaValidationResult> {
  const settings =
    await getFieldServiceAreaSettings(
      params.tenantId
    );

  if (!settings.enabled) {
    return {
      allowed: true,
      validationApplied: false,
      reason: "FIELD_SERVICE_AREA_DISABLED",
      distanceMiles: null,
      radiusMiles: settings.radiusMiles,
    };
  }

  if (
    settings.baseLatitude === null ||
    settings.baseLongitude === null ||
    settings.radiusMiles === null
  ) {
    return {
      allowed: false,
      validationApplied: true,
      reason:
        "FIELD_SERVICE_AREA_NOT_CONFIGURED",
      distanceMiles: null,
      radiusMiles: settings.radiusMiles,
    };
  }

  const distanceMiles =
    calculateDistanceMiles({
      fromLatitude:
        settings.baseLatitude,
      fromLongitude:
        settings.baseLongitude,
      toLatitude:
        params.latitude,
      toLongitude:
        params.longitude,
    });

  const allowed =
    distanceMiles <= settings.radiusMiles;

  return {
    allowed,
    validationApplied: true,
    reason: allowed
      ? null
      : "FIELD_SERVICE_LOCATION_OUTSIDE_RADIUS",
    distanceMiles:
      Math.round(distanceMiles * 100) / 100,
    radiusMiles:
      settings.radiusMiles,
  };
}