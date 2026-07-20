//src/modules/field-operations/services/fieldOperationsSync.service.ts

import {
  setAppointmentFieldLocation,
} from "./appointmentFieldOperations.service";

export type SyncAppointmentToFieldOperationsInput = {
  tenantId: string;
  appointmentId: string;

  answersBySlot: Record<
    string,
    string | null | undefined
  >;
};

function clean(value: unknown): string | null {
  const v = String(value ?? "").trim();
  return v || null;
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
}