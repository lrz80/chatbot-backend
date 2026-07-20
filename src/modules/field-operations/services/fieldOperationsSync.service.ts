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

export async function syncAppointmentToFieldOperations(
  input: SyncAppointmentToFieldOperationsInput
): Promise<void> {
  const address =
    clean(input.answersBySlot.address) ??
    clean(input.answersBySlot.service_address) ??
    clean(input.answersBySlot.location) ??
    clean(input.answersBySlot.property_address);

  if (!address) {
    return;
  }

  await setAppointmentFieldLocation({
    tenantId: input.tenantId,
    appointmentId: input.appointmentId,
    locationType: "service",
    formattedAddress: address,
    latitude: null,
    longitude: null,
    geocodingStatus: "pending",
  });

  try {
    const result = await geocodeAppointmentLocation({
      tenantId: input.tenantId,
      appointmentId: input.appointmentId,
    });

    if (
      result.status === "failed" ||
      result.status === "not_found"
    ) {
      console.error(
        "[FIELD_OPERATIONS][AUTOMATIC_GEOCODING_NOT_COMPLETED]",
        {
          tenantId: input.tenantId,
          appointmentId: input.appointmentId,
          status: result.status,
          error: result.error,
        }
      );
    }
  } catch (error) {
    console.error(
      "[FIELD_OPERATIONS][AUTOMATIC_GEOCODING_UNEXPECTED_ERROR]",
      {
        tenantId: input.tenantId,
        appointmentId: input.appointmentId,
        error: normalizeError(error),
      }
    );
  }
}