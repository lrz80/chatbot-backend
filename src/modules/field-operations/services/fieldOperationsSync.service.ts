// src/modules/field-operations/services/fieldOperationsSync.service.ts

import {
  setAppointmentFieldLocation,
} from "./appointmentFieldOperations.service";

import {
  geocodeAppointmentLocation,
} from "./appointmentGeocoding.service";

export type SyncAppointmentToFieldOperationsInput = {
  tenantId: string;
  appointmentId: string;

  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;

  answersBySlot: Record<
    string,
    string | null | undefined
  >;
};

function clean(
  value: unknown
): string | null {
  const result =
    String(value ?? "").trim();

  return result || null;
}

function normalizeError(
  error: unknown
): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

export async function syncAppointmentToFieldOperations(
  input: SyncAppointmentToFieldOperationsInput
): Promise<void> {
  const address =
    clean(input.address) ??
    clean(
      input.answersBySlot.address
    ) ??
    clean(
      input.answersBySlot.service_address
    ) ??
    clean(
      input.answersBySlot.location
    ) ??
    clean(
      input.answersBySlot.property_address
    );

  const latitude =
    typeof input.latitude === "number" &&
    Number.isFinite(input.latitude)
      ? input.latitude
      : null;

  const longitude =
    typeof input.longitude === "number" &&
    Number.isFinite(input.longitude)
      ? input.longitude
      : null;

  const hasResolvedCoordinates =
    latitude !== null &&
    longitude !== null;

  if (!address) {
    throw new Error(
      "FIELD_SERVICE_ADDRESS_REQUIRED"
    );
  }

  console.log(
    "[FIELD_OPERATIONS][LOCATION_SYNC_STARTED]",
    {
      tenantId:
        input.tenantId,

      appointmentId:
        input.appointmentId,

      address,

      hasResolvedCoordinates,
    }
  );

  await setAppointmentFieldLocation({
    tenantId:
      input.tenantId,

    appointmentId:
      input.appointmentId,

    locationType:
      "service",

    formattedAddress:
      address,

    latitude,

    longitude,

    geocodingStatus:
      hasResolvedCoordinates
        ? "geocoded"
        : "pending",
  });

  if (hasResolvedCoordinates) {
    console.log(
      "[FIELD_OPERATIONS][LOCATION_SYNC_COMPLETED]",
      {
        tenantId:
          input.tenantId,

        appointmentId:
          input.appointmentId,

        address,
        latitude,
        longitude,

        geocodingReused:
          true,
      }
    );

    return;
  }

  console.log(
    "[FIELD_OPERATIONS][LOCATION_SAVED_PENDING_GEOCODING]",
    {
      tenantId:
        input.tenantId,

      appointmentId:
        input.appointmentId,

      address,
    }
  );

  try {
    console.log(
      "[FIELD_OPERATIONS][GEOCODING_REQUEST_STARTED]",
      {
        tenantId:
          input.tenantId,

        appointmentId:
          input.appointmentId,
      }
    );

    const result =
      await geocodeAppointmentLocation({
        tenantId:
          input.tenantId,

        appointmentId:
          input.appointmentId,
      });

    console.log(
      "[FIELD_OPERATIONS][GEOCODING_REQUEST_COMPLETED]",
      {
        tenantId:
          input.tenantId,

        appointmentId:
          input.appointmentId,

        status:
          result.status,

        error:
          result.error,

        latitude:
          result.geocoding
            ?.latitude ??
          null,

        longitude:
          result.geocoding
            ?.longitude ??
          null,
      }
    );
  } catch (error) {
    console.error(
      "[FIELD_OPERATIONS][GEOCODING_FAILED]",
      {
        tenantId:
          input.tenantId,

        appointmentId:
          input.appointmentId,

        error:
          normalizeError(error),
      }
    );

    throw error;
  }
}