// src/modules/field-operations/services/resourceCandidatePlanner.service.ts

import pool from "../../../lib/db";

import {
  listFieldOperationResources,
} from "../repositories/fieldResources.repo";

import type {
  FieldOperationResource,
} from "../domain/fieldOperations.types";

const ACTIVE_ASSIGNMENT_STATUSES = [
  "assigned",
  "accepted",
  "confirmed",
  "dispatched",
  "en_route",
  "arrived",
  "in_progress",
];

const DEFAULT_APPOINTMENT_DURATION_MINUTES = 60;

const DISPATCH_WEIGHTS = {
  distancePerKm: 10,
  missingDistancePenalty: 50,
  appointmentCountPenalty: 8,
  assignedHourPenalty: 3,
  customerContinuityBonus: -25,
} as const;

type RouteNeighborRow = {
  appointment_id: string;
  start_time: Date | string;
  end_time: Date | string | null;
  latitude: number | string | null;
  longitude: number | string | null;
};

export type ResourceCandidateScore = {
  incrementalDistanceKm: number | null;
  distancePenalty: number;

  appointmentCount: number;
  assignedMinutes: number;
  workloadPenalty: number;

  previousCustomerResource: boolean;
  continuityBonus: number;

  totalScore: number;
};

export type PlannedResourceCandidate = {
  resource: FieldOperationResource;

  eligible: boolean;

  rejectionReason:
    | "TIME_CONFLICT"
    | "INVALID_RESOURCE"
    | null;

  score: ResourceCandidateScore;
};

export type PlanResourceCandidatesInput = {
  tenantId: string;

  startAt: Date | string;
  endAt?: Date | string | null;

  latitude?: number | null;
  longitude?: number | null;

  customerPhone?: string | null;

  /**
   * Se usa cuando estamos recalculando una cita existente.
   * Durante una reserva nueva debe quedar null.
   */
  excludedAppointmentId?: string | null;

  /**
   * Cuando el cliente solicita una persona o recurso específico.
   */
  requestedResourceId?: string | null;
};

export type PlanResourceCandidatesResult = {
  status:
    | "planned"
    | "no_active_resources"
    | "no_eligible_resources"
    | "requested_resource_not_found";

  bestCandidate: PlannedResourceCandidate | null;

  candidates: PlannedResourceCandidate[];

  candidatesEvaluated: number;
  candidatesRejected: number;
};

function requiredString(
  value: unknown,
  fieldName: string
): string {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(
      `FIELD_OPERATIONS_REQUIRED_FIELD:${fieldName}`
    );
  }

  return normalized;
}

function optionalString(
  value: unknown
): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function numberOrNull(
  value: unknown
): number | null {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

function toDate(
  value: Date | string,
  fieldName: string
): Date {
  const parsed =
    value instanceof Date
      ? new Date(value.getTime())
      : new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `FIELD_OPERATIONS_INVALID_DATE:${fieldName}`
    );
  }

  return parsed;
}

function normalizeTimezone(
  resource: FieldOperationResource
): string {
  return (
    String(resource.timezone ?? "").trim() ||
    "America/New_York"
  );
}

function emptyScore(): ResourceCandidateScore {
  return {
    incrementalDistanceKm: null,
    distancePenalty: 0,

    appointmentCount: 0,
    assignedMinutes: 0,
    workloadPenalty: 0,

    previousCustomerResource: false,
    continuityBonus: 0,

    totalScore: Number.POSITIVE_INFINITY,
  };
}

function haversineDistanceKm(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number
): number {
  const earthRadiusKm = 6371;

  const radians = (
    degrees: number
  ): number => degrees * Math.PI / 180;

  const latitudeDifference = radians(
    latitudeB - latitudeA
  );

  const longitudeDifference = radians(
    longitudeB - longitudeA
  );

  const value =
    Math.sin(latitudeDifference / 2) ** 2 +
    Math.cos(radians(latitudeA)) *
      Math.cos(radians(latitudeB)) *
      Math.sin(longitudeDifference / 2) ** 2;

  return (
    2 *
    earthRadiusKm *
    Math.atan2(
      Math.sqrt(value),
      Math.sqrt(1 - value)
    )
  );
}

async function hasTimeConflict(input: {
  tenantId: string;
  resourceId: string;

  excludedAppointmentId: string | null;

  startAt: Date;
  endAt: Date;
}): Promise<boolean> {
  const { rows } =
    await pool.query<{ conflict: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1

        FROM appointment_resource_assignments ara

        INNER JOIN appointments a
          ON a.tenant_id::text = ara.tenant_id
         AND a.id::text = ara.appointment_id

        WHERE ara.tenant_id = $1
          AND ara.resource_id = $2

          AND (
            $3::text IS NULL
            OR ara.appointment_id <> $3
          )

          AND ara.assignment_status =
            ANY($4::text[])

          AND COALESCE(
            LOWER(a.status),
            ''
          ) <> 'cancelled'

          AND a.start_time < $6::timestamptz

          AND COALESCE(
            a.end_time,
            a.start_time +
              make_interval(
                mins => $7::int
              )
          ) > $5::timestamptz
      ) AS conflict
      `,
      [
        input.tenantId,
        input.resourceId,
        input.excludedAppointmentId,
        ACTIVE_ASSIGNMENT_STATUSES,
        input.startAt.toISOString(),
        input.endAt.toISOString(),
        DEFAULT_APPOINTMENT_DURATION_MINUTES,
      ]
    );

  return Boolean(rows[0]?.conflict);
}

async function getDailyLoad(input: {
  tenantId: string;
  resourceId: string;
  startAt: Date;
  timezone: string;
}): Promise<{
  appointmentCount: number;
  assignedMinutes: number;
}> {
  const { rows } =
    await pool.query<{
      appointment_count: number | string;
      assigned_minutes: number | string;
    }>(
      `
      SELECT
        COUNT(*)::int AS appointment_count,

        COALESCE(
          SUM(
            EXTRACT(
              EPOCH FROM (
                COALESCE(
                  a.end_time,
                  a.start_time +
                    make_interval(
                      mins => $5::int
                    )
                ) - a.start_time
              )
            ) / 60
          ),
          0
        )::float AS assigned_minutes

      FROM appointment_resource_assignments ara

      INNER JOIN appointments a
        ON a.tenant_id::text = ara.tenant_id
       AND a.id::text = ara.appointment_id

      WHERE ara.tenant_id = $1
        AND ara.resource_id = $2

        AND ara.assignment_status =
          ANY($3::text[])

        AND COALESCE(
          LOWER(a.status),
          ''
        ) <> 'cancelled'

        AND a.start_time >= (
          DATE_TRUNC(
            'day',
            $4::timestamptz AT TIME ZONE $6
          )
          AT TIME ZONE $6
        )

        AND a.start_time < (
          (
            DATE_TRUNC(
              'day',
              $4::timestamptz AT TIME ZONE $6
            ) +
            INTERVAL '1 day'
          )
          AT TIME ZONE $6
        )
      `,
      [
        input.tenantId,
        input.resourceId,
        ACTIVE_ASSIGNMENT_STATUSES,
        input.startAt.toISOString(),
        DEFAULT_APPOINTMENT_DURATION_MINUTES,
        input.timezone,
      ]
    );

  return {
    appointmentCount:
      Number(rows[0]?.appointment_count ?? 0),

    assignedMinutes:
      Number(rows[0]?.assigned_minutes ?? 0),
  };
}

async function getPreviousRouteNeighbor(input: {
  tenantId: string;
  resourceId: string;
  excludedAppointmentId: string | null;
  startAt: Date;
}): Promise<RouteNeighborRow | null> {
  const { rows } =
    await pool.query<RouteNeighborRow>(
      `
      SELECT
        a.id::text AS appointment_id,
        a.start_time,
        a.end_time,
        al.latitude,
        al.longitude

      FROM appointment_resource_assignments ara

      INNER JOIN appointments a
        ON a.tenant_id::text = ara.tenant_id
       AND a.id::text = ara.appointment_id

      LEFT JOIN appointment_locations al
        ON al.tenant_id = a.tenant_id::text
       AND al.appointment_id = a.id::text
       AND al.location_type = 'service'

      WHERE ara.tenant_id = $1
        AND ara.resource_id = $2

        AND (
          $3::text IS NULL
          OR ara.appointment_id <> $3
        )

        AND ara.assignment_status =
          ANY($4::text[])

        AND COALESCE(
          LOWER(a.status),
          ''
        ) <> 'cancelled'

        AND COALESCE(
          a.end_time,
          a.start_time +
            make_interval(
              mins => $6::int
            )
        ) <= $5::timestamptz

      ORDER BY
        COALESCE(
          a.end_time,
          a.start_time +
            make_interval(
              mins => $6::int
            )
        ) DESC

      LIMIT 1
      `,
      [
        input.tenantId,
        input.resourceId,
        input.excludedAppointmentId,
        ACTIVE_ASSIGNMENT_STATUSES,
        input.startAt.toISOString(),
        DEFAULT_APPOINTMENT_DURATION_MINUTES,
      ]
    );

  return rows[0] ?? null;
}

async function getNextRouteNeighbor(input: {
  tenantId: string;
  resourceId: string;
  excludedAppointmentId: string | null;
  endAt: Date;
}): Promise<RouteNeighborRow | null> {
  const { rows } =
    await pool.query<RouteNeighborRow>(
      `
      SELECT
        a.id::text AS appointment_id,
        a.start_time,
        a.end_time,
        al.latitude,
        al.longitude

      FROM appointment_resource_assignments ara

      INNER JOIN appointments a
        ON a.tenant_id::text = ara.tenant_id
       AND a.id::text = ara.appointment_id

      LEFT JOIN appointment_locations al
        ON al.tenant_id = a.tenant_id::text
       AND al.appointment_id = a.id::text
       AND al.location_type = 'service'

      WHERE ara.tenant_id = $1
        AND ara.resource_id = $2

        AND (
          $3::text IS NULL
          OR ara.appointment_id <> $3
        )

        AND ara.assignment_status =
          ANY($4::text[])

        AND COALESCE(
          LOWER(a.status),
          ''
        ) <> 'cancelled'

        AND a.start_time >= $5::timestamptz

      ORDER BY
        a.start_time ASC

      LIMIT 1
      `,
      [
        input.tenantId,
        input.resourceId,
        input.excludedAppointmentId,
        ACTIVE_ASSIGNMENT_STATUSES,
        input.endAt.toISOString(),
      ]
    );

  return rows[0] ?? null;
}

async function wasPreviousResourceForCustomer(input: {
  tenantId: string;
  resourceId: string;
  excludedAppointmentId: string | null;
  customerPhone: string | null;
  startAt: Date;
}): Promise<boolean> {
  if (!input.customerPhone) {
    return false;
  }

  const { rows } =
    await pool.query<{ matched: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1

        FROM appointment_resource_assignments ara

        INNER JOIN appointments a
          ON a.tenant_id::text = ara.tenant_id
         AND a.id::text = ara.appointment_id

        WHERE ara.tenant_id = $1
          AND ara.resource_id = $2

          AND (
            $3::text IS NULL
            OR ara.appointment_id <> $3
          )

          AND ara.assignment_status =
            ANY($4::text[])

          AND a.customer_phone = $5
          AND a.start_time < $6::timestamptz

          AND COALESCE(
            LOWER(a.status),
            ''
          ) <> 'cancelled'
      ) AS matched
      `,
      [
        input.tenantId,
        input.resourceId,
        input.excludedAppointmentId,
        ACTIVE_ASSIGNMENT_STATUSES,
        input.customerPhone,
        input.startAt.toISOString(),
      ]
    );

  return Boolean(rows[0]?.matched);
}

function coordinatesFromNeighbor(
  neighbor: RouteNeighborRow | null
): {
  latitude: number;
  longitude: number;
} | null {
  const latitude =
    numberOrNull(neighbor?.latitude);

  const longitude =
    numberOrNull(neighbor?.longitude);

  if (
    latitude === null ||
    longitude === null
  ) {
    return null;
  }

  return {
    latitude,
    longitude,
  };
}

function calculateIncrementalDistanceKm(input: {
  resource: FieldOperationResource;

  appointmentLatitude: number | null;
  appointmentLongitude: number | null;

  previousNeighbor: RouteNeighborRow | null;
  nextNeighbor: RouteNeighborRow | null;
}): number | null {
  if (
    input.appointmentLatitude === null ||
    input.appointmentLongitude === null
  ) {
    return null;
  }

  const previousCoordinates =
    coordinatesFromNeighbor(
      input.previousNeighbor
    ) ??
    (
      input.resource.startLatitude !== null &&
      input.resource.startLongitude !== null
        ? {
            latitude:
              input.resource.startLatitude,

            longitude:
              input.resource.startLongitude,
          }
        : null
    );

  const nextCoordinates =
    coordinatesFromNeighbor(
      input.nextNeighbor
    );

  if (!previousCoordinates) {
    return null;
  }

  const distanceToAppointment =
    haversineDistanceKm(
      previousCoordinates.latitude,
      previousCoordinates.longitude,
      input.appointmentLatitude,
      input.appointmentLongitude
    );

  if (!nextCoordinates) {
    return distanceToAppointment;
  }

  const distanceAppointmentToNext =
    haversineDistanceKm(
      input.appointmentLatitude,
      input.appointmentLongitude,
      nextCoordinates.latitude,
      nextCoordinates.longitude
    );

  const existingDirectDistance =
    haversineDistanceKm(
      previousCoordinates.latitude,
      previousCoordinates.longitude,
      nextCoordinates.latitude,
      nextCoordinates.longitude
    );

  return Math.max(
    0,
    distanceToAppointment +
      distanceAppointmentToNext -
      existingDirectDistance
  );
}

async function evaluateResourceCandidate(input: {
  tenantId: string;

  resource: FieldOperationResource;

  startAt: Date;
  endAt: Date;

  latitude: number | null;
  longitude: number | null;

  customerPhone: string | null;
  excludedAppointmentId: string | null;
}): Promise<PlannedResourceCandidate> {
  const conflict =
    await hasTimeConflict({
      tenantId: input.tenantId,
      resourceId: input.resource.id,

      excludedAppointmentId:
        input.excludedAppointmentId,

      startAt: input.startAt,
      endAt: input.endAt,
    });

  if (conflict) {
    return {
      resource: input.resource,
      eligible: false,
      rejectionReason: "TIME_CONFLICT",
      score: emptyScore(),
    };
  }

  const timezone =
    normalizeTimezone(input.resource);

  const [
    load,
    previousNeighbor,
    nextNeighbor,
    previousCustomerResource,
  ] = await Promise.all([
    getDailyLoad({
      tenantId: input.tenantId,
      resourceId: input.resource.id,
      startAt: input.startAt,
      timezone,
    }),

    getPreviousRouteNeighbor({
      tenantId: input.tenantId,
      resourceId: input.resource.id,

      excludedAppointmentId:
        input.excludedAppointmentId,

      startAt: input.startAt,
    }),

    getNextRouteNeighbor({
      tenantId: input.tenantId,
      resourceId: input.resource.id,

      excludedAppointmentId:
        input.excludedAppointmentId,

      endAt: input.endAt,
    }),

    wasPreviousResourceForCustomer({
      tenantId: input.tenantId,
      resourceId: input.resource.id,

      excludedAppointmentId:
        input.excludedAppointmentId,

      customerPhone:
        input.customerPhone,

      startAt: input.startAt,
    }),
  ]);

  const incrementalDistanceKm =
    calculateIncrementalDistanceKm({
      resource: input.resource,

      appointmentLatitude:
        input.latitude,

      appointmentLongitude:
        input.longitude,

      previousNeighbor,
      nextNeighbor,
    });

  const distancePenalty =
    incrementalDistanceKm === null
      ? DISPATCH_WEIGHTS.missingDistancePenalty
      : incrementalDistanceKm *
          DISPATCH_WEIGHTS.distancePerKm;

  const workloadPenalty =
    load.appointmentCount *
      DISPATCH_WEIGHTS.appointmentCountPenalty +
    (
      load.assignedMinutes / 60
    ) *
      DISPATCH_WEIGHTS.assignedHourPenalty;

  const continuityBonus =
    previousCustomerResource
      ? DISPATCH_WEIGHTS.customerContinuityBonus
      : 0;

  const totalScore =
    distancePenalty +
    workloadPenalty +
    continuityBonus;

  return {
    resource: input.resource,

    eligible: true,
    rejectionReason: null,

    score: {
      incrementalDistanceKm,
      distancePenalty,

      appointmentCount:
        load.appointmentCount,

      assignedMinutes:
        load.assignedMinutes,

      workloadPenalty,

      previousCustomerResource,
      continuityBonus,

      totalScore,
    },
  };
}

export async function planResourceCandidates(
  input: PlanResourceCandidatesInput
): Promise<PlanResourceCandidatesResult> {
  const tenantId = requiredString(
    input.tenantId,
    "tenantId"
  );

  const startAt = toDate(
    input.startAt,
    "startAt"
  );

  const endAt =
    input.endAt
      ? toDate(
          input.endAt,
          "endAt"
        )
      : new Date(
          startAt.getTime() +
            DEFAULT_APPOINTMENT_DURATION_MINUTES *
              60 *
              1000
        );

  if (endAt.getTime() <= startAt.getTime()) {
    throw new Error(
      "FIELD_OPERATIONS_INVALID_APPOINTMENT_RANGE"
    );
  }

  const latitude =
    numberOrNull(input.latitude);

  const longitude =
    numberOrNull(input.longitude);

  const requestedResourceId =
    optionalString(
      input.requestedResourceId
    );

  const resources =
    await listFieldOperationResources({
      tenantId,
      active: true,
    });

  if (resources.length === 0) {
    return {
      status: "no_active_resources",

      bestCandidate: null,
      candidates: [],

      candidatesEvaluated: 0,
      candidatesRejected: 0,
    };
  }

  const filteredResources =
    requestedResourceId
      ? resources.filter(
          (resource) =>
            resource.id ===
            requestedResourceId
        )
      : resources;

  if (
    requestedResourceId &&
    filteredResources.length === 0
  ) {
    return {
      status:
        "requested_resource_not_found",

      bestCandidate: null,
      candidates: [],

      candidatesEvaluated: 0,
      candidatesRejected: 0,
    };
  }

  const candidates:
    PlannedResourceCandidate[] = [];

  // Secuencial para no disparar demasiadas consultas
  // simultáneas por cada búsqueda de horario.
  for (const resource of filteredResources) {
    const candidate =
      await evaluateResourceCandidate({
        tenantId,
        resource,

        startAt,
        endAt,

        latitude,
        longitude,

        customerPhone:
          optionalString(
            input.customerPhone
          ),

        excludedAppointmentId:
          optionalString(
            input.excludedAppointmentId
          ),
      });

    candidates.push(candidate);
  }

  candidates.sort(
    (candidateA, candidateB) =>
      Number(candidateB.eligible) -
        Number(candidateA.eligible) ||
      candidateA.score.totalScore -
        candidateB.score.totalScore ||
      candidateA.resource.name.localeCompare(
        candidateB.resource.name
      ) ||
      candidateA.resource.id.localeCompare(
        candidateB.resource.id
      )
  );

  const bestCandidate =
    candidates.find(
      (candidate) =>
        candidate.eligible
    ) ?? null;

  const candidatesRejected =
    candidates.filter(
      (candidate) =>
        !candidate.eligible
    ).length;

  return {
    status:
      bestCandidate
        ? "planned"
        : "no_eligible_resources",

    bestCandidate,
    candidates,

    candidatesEvaluated:
      candidates.length,

    candidatesRejected,
  };
}