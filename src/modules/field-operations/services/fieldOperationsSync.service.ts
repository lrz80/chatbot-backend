// src/modules/field-operations/services/fieldOperationsSync.service.ts

import {
  setAppointmentFieldLocation,
} from "./appointmentFieldOperations.service";

import {
  geocodeAppointmentLocation,
} from "./appointmentGeocoding.service";

import {
  automaticallyAssignBestResource,
} from "./automaticResourceAssignment.service";

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

function clean(value: unknown): string | null {
  const result = String(value ?? "").trim();
  return result || null;
}

function normalizeError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

function validCoordinate(
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

async function assignBestResourceSafely(input: {
  tenantId: string;
  appointmentId: string;
}): Promise<void> {
  try {
    const result = await automaticallyAssignBestResource({
      tenantId: input.tenantId,
      appointmentId: input.appointmentId,
    });

    console.log(
      "[FIELD_OPERATIONS][AUTOMATIC_RESOURCE_ASSIGNMENT_COMPLETED]",
      {
        tenantId: input.tenantId,
        appointmentId: input.appointmentId,
        status: result.status,
        resourceId: result.resourceId,
        resourceName: result.resourceName,
        score: result.score,
        reason: result.reason,
        candidatesEvaluated:
          result.candidatesEvaluated,
        candidatesRejected:
          result.candidatesRejected,
      }
    );
  } catch (error) {
    console.error(
      "[FIELD_OPERATIONS][AUTOMATIC_RESOURCE_ASSIGNMENT_FAILED]",
      {
        tenantId: input.tenantId,
        appointmentId: input.appointmentId,
        error: normalizeError(error),
      }
    );
  }
}

export async function syncAppointmentToFieldOperations(
  input: SyncAppointmentToFieldOperationsInput
): Promise<void> {
  const address =
    clean(input.address) ??
    clean(input.answersBySlot.address) ??
    clean(input.answersBySlot.service_address) ??
    clean(input.answersBySlot.location) ??
    clean(input.answersBySlot.property_address);

  const latitude = validCoordinate(
    input.latitude,
    -90,
    90
  );

  const longitude = validCoordinate(
    input.longitude,
    -180,
    180
  );

  const hasResolvedCoordinates =
    latitude !== null &&
    longitude !== null;

  if (!address) {
    console.log(
      "[FIELD_OPERATIONS][LOCATION_SYNC_SKIPPED]",
      {
        tenantId: input.tenantId,
        appointmentId: input.appointmentId,
        reason: "SERVICE_ADDRESS_NOT_AVAILABLE",
      }
    );

    await assignBestResourceSafely({
      tenantId: input.tenantId,
      appointmentId: input.appointmentId,
    });

    return;
  }

  console.log(
    "[FIELD_OPERATIONS][LOCATION_SYNC_STARTED]",
    {
      tenantId: input.tenantId,
      appointmentId: input.appointmentId,
      address,
      hasResolvedCoordinates,
    }
  );

  await setAppointmentFieldLocation({
    tenantId: input.tenantId,
    appointmentId: input.appointmentId,
    locationType: "service",
    formattedAddress: address,
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
        tenantId: input.tenantId,
        appointmentId: input.appointmentId,
        address,
        latitude,
        longitude,
        geocodingReused: true,
      }
    );
  } else {
    console.log(
      "[FIELD_OPERATIONS][LOCATION_SAVED_PENDING_GEOCODING]",
      {
        tenantId: input.tenantId,
        appointmentId: input.appointmentId,
        address,
      }
    );

    try {
      console.log(
        "[FIELD_OPERATIONS][GEOCODING_REQUEST_STARTED]",
        {
          tenantId: input.tenantId,
          appointmentId: input.appointmentId,
        }
      );

      const result =
        await geocodeAppointmentLocation({
          tenantId: input.tenantId,
          appointmentId: input.appointmentId,
        });

      console.log(
        "[FIELD_OPERATIONS][GEOCODING_REQUEST_COMPLETED]",
        {
          tenantId: input.tenantId,
          appointmentId: input.appointmentId,
          status: result.status,
          error: result.error,
          latitude:
            result.geocoding?.latitude ?? null,
          longitude:
            result.geocoding?.longitude ?? null,
        }
      );
    } catch (error) {
      console.error(
        "[FIELD_OPERATIONS][GEOCODING_FAILED]",
        {
          tenantId: input.tenantId,
          appointmentId: input.appointmentId,
          error: normalizeError(error),
        }
      );
    }
  }

  // Assignment runs after geocoding so distance scoring can use coordinates.
  await assignBestResourceSafely({
    tenantId: input.tenantId,
    appointmentId: input.appointmentId,
  });

  console.log(
    "[FIELD_OPERATIONS][APPOINTMENT_SYNC_COMPLETED]",
    {
      tenantId: input.tenantId,
      appointmentId: input.appointmentId,
    }
  );
}