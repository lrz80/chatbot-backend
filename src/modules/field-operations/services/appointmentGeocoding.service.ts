// src/modules/field-operations/services/appointmentGeocoding.service.ts

import {
  getAppointmentLocation,
  updateAppointmentLocationGeocoding,
} from "../repositories/appointmentLocations.repo";

import type {
  GeocodingProvider,
  GeocodingResult,
} from "../providers/geocodingProvider.types";

import {
  googleMapsGeocodingProvider,
} from "../providers/googleMapsGeocoding.provider";

export type GeocodeAppointmentLocationInput = {
  tenantId: string;
  appointmentId: string;
  language?: string;
  region?: string;
  force?: boolean;
  provider?: GeocodingProvider;
};

export type GeocodeAppointmentLocationResult = {
  appointmentId: string;
  status:
    | "geocoded"
    | "already_geocoded"
    | "not_found"
    | "failed";
  geocoding: GeocodingResult | null;
  error: string | null;
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

function hasValidCoordinates(
  latitude: unknown,
  longitude: unknown
): boolean {
  const lat = Number(latitude);
  const lng = Number(longitude);

  return (
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    Number.isFinite(lng) &&
    lng >= -180 &&
    lng <= 180
  );
}

function normalizeError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

export async function geocodeAppointmentLocation(
  input: GeocodeAppointmentLocationInput
): Promise<GeocodeAppointmentLocationResult> {
  const tenantId = requiredString(
    input.tenantId,
    "tenantId"
  );

  const appointmentId = requiredString(
    input.appointmentId,
    "appointmentId"
  );

  const provider =
    input.provider ??
    googleMapsGeocodingProvider;

  try {
    const location = await getAppointmentLocation({
      tenantId,
      appointmentId,
      locationType: "service",
    });

    if (!location) {
      throw new Error(
        "FIELD_OPERATIONS_APPOINTMENT_LOCATION_NOT_FOUND"
      );
    }

    if (
      !input.force &&
      hasValidCoordinates(
        location.latitude,
        location.longitude
      )
    ) {
      return {
        appointmentId,
        status: "already_geocoded",
        geocoding: {
          formattedAddress:
            location.formattedAddress,
          latitude: Number(location.latitude),
          longitude: Number(location.longitude),
          placeId:
            location.providerPlaceId ?? null,
          partialMatch: false,
          locationType: null,
          addressComponents: [],
          providerMetadata: {},
        },
        error: null,
      };
    }

    const geocoding = await provider.geocode({
      address: location.formattedAddress,
      language: input.language,
      region: input.region,
    });

    if (!geocoding) {
      await updateAppointmentLocationGeocoding({
        tenantId,
        appointmentId,
        locationType: "service",
        latitude: null,
        longitude: null,
        geocodingProvider: provider.name,
        providerPlaceId: null,
        geocodingStatus: "not_found",
        geocodingError:
          "FIELD_OPERATIONS_GEOCODING_ZERO_RESULTS",
      });

      return {
        appointmentId,
        status: "not_found",
        geocoding: null,
        error:
          "FIELD_OPERATIONS_GEOCODING_ZERO_RESULTS",
      };
    }

    await updateAppointmentLocationGeocoding({
      tenantId,
      appointmentId,
      locationType: "service",
      formattedAddress:
        geocoding.formattedAddress,
      addressComponents: {
        components:
          geocoding.addressComponents,
        partialMatch:
          geocoding.partialMatch,
        locationType:
          geocoding.locationType,
        providerMetadata:
          geocoding.providerMetadata,
      },
      latitude: geocoding.latitude,
      longitude: geocoding.longitude,
      geocodingProvider: provider.name,
      providerPlaceId: geocoding.placeId,
      geocodingStatus: "geocoded",
      geocodingError: null,
    });

    return {
      appointmentId,
      status: "geocoded",
      geocoding,
      error: null,
    };
  } catch (error) {
    const message = normalizeError(error);

    try {
      await updateAppointmentLocationGeocoding({
        tenantId,
        appointmentId,
        locationType: "service",
        latitude: null,
        longitude: null,
        geocodingProvider: provider.name,
        providerPlaceId: null,
        geocodingStatus: "failed",
        geocodingError: message,
      });
    } catch (updateError) {
      console.error(
        "[FIELD_OPERATIONS][GEOCODING_STATUS_UPDATE_FAILED]",
        {
          tenantId,
          appointmentId,
          originalError: message,
          updateError: normalizeError(updateError),
        }
      );
    }

    return {
      appointmentId,
      status: "failed",
      geocoding: null,
      error: message,
    };
  }
}