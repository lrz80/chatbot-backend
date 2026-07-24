// src/modules/field-operations/services/bookingPlanning.service.ts

import {
  planResourceCandidates,
  type PlannedResourceCandidate,
} from "./resourceCandidatePlanner.service";

export type PlanFieldServiceBookingInput = {
  tenantId: string;

  startAt: Date | string;
  endAt: Date | string;

  latitude: number;
  longitude: number;

  customerPhone?: string | null;

  /**
   * Recurso explícitamente solicitado por el cliente.
   *
   * Debe ser el ID interno de field_operation_resources,
   * no el team_member_id externo de Square.
   */
  requestedResourceId?: string | null;
};

export type PlanFieldServiceBookingResult =
  | {
      ok: true;

      resourceId: string;
      resourceName: string;

      candidate: PlannedResourceCandidate;

      candidatesEvaluated: number;
      candidatesRejected: number;
    }
  | {
      ok: false;

      error:
        | "NO_ACTIVE_RESOURCES"
        | "NO_ROUTE_FEASIBLE_RESOURCE"
        | "REQUESTED_RESOURCE_NOT_FOUND";

      candidatesEvaluated: number;
      candidatesRejected: number;

      rejectedCandidates: Array<{
        resourceId: string;
        resourceName: string;
        reason: string | null;
      }>;
    };

function requiredString(
  value: unknown,
  fieldName: string
): string {
  const normalized =
    String(value ?? "").trim();

  if (!normalized) {
    throw new Error(
      `FIELD_OPERATIONS_REQUIRED_FIELD:${fieldName}`
    );
  }

  return normalized;
}

function validCoordinate(
  value: unknown,
  minimum: number,
  maximum: number,
  fieldName: string
): number {
  const parsed = Number(value);

  if (
    !Number.isFinite(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(
      `FIELD_OPERATIONS_INVALID_COORDINATE:${fieldName}`
    );
  }

  return parsed;
}

export async function planFieldServiceBooking(
  input: PlanFieldServiceBookingInput
): Promise<PlanFieldServiceBookingResult> {
  const tenantId =
    requiredString(
      input.tenantId,
      "tenantId"
    );

  const latitude =
    validCoordinate(
      input.latitude,
      -90,
      90,
      "latitude"
    );

  const longitude =
    validCoordinate(
      input.longitude,
      -180,
      180,
      "longitude"
    );

  const planning =
    await planResourceCandidates({
      tenantId,

      startAt:
        input.startAt,

      endAt:
        input.endAt,

      latitude,
      longitude,

      customerPhone:
        input.customerPhone,

      requestedResourceId:
        input.requestedResourceId,

      excludedAppointmentId:
        null,
    });

  if (
    planning.status ===
    "no_active_resources"
  ) {
    return {
      ok: false,

      error:
        "NO_ACTIVE_RESOURCES",

      candidatesEvaluated:
        planning.candidatesEvaluated,

      candidatesRejected:
        planning.candidatesRejected,

      rejectedCandidates: [],
    };
  }

  if (
    planning.status ===
    "requested_resource_not_found"
  ) {
    return {
      ok: false,

      error:
        "REQUESTED_RESOURCE_NOT_FOUND",

      candidatesEvaluated:
        planning.candidatesEvaluated,

      candidatesRejected:
        planning.candidatesRejected,

      rejectedCandidates: [],
    };
  }

  if (!planning.bestCandidate) {
    return {
      ok: false,

      error:
        "NO_ROUTE_FEASIBLE_RESOURCE",

      candidatesEvaluated:
        planning.candidatesEvaluated,

      candidatesRejected:
        planning.candidatesRejected,

      rejectedCandidates:
        planning.candidates.map(
          (candidate) => ({
            resourceId:
              candidate.resource.id,

            resourceName:
              candidate.resource.name,

            reason:
              candidate.rejectionReason,
          })
        ),
    };
  }

  return {
    ok: true,

    resourceId:
      planning.bestCandidate.resource.id,

    resourceName:
      planning.bestCandidate.resource.name,

    candidate:
      planning.bestCandidate,

    candidatesEvaluated:
      planning.candidatesEvaluated,

    candidatesRejected:
      planning.candidatesRejected,
  };
}