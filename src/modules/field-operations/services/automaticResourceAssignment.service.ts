// src/modules/field-operations/services/automaticResourceAssignment.service.ts

import pool from "../../../lib/db";

import {
  listFieldOperationResources,
} from "../repositories/fieldResources.repo";

import {
  listResourceAssignments,
  saveResourceAssignment,
} from "../repositories/resourceAssignments.repo";

import type {
  FieldOperationResource,
} from "../domain/fieldOperations.types";

type AppointmentRow = {
  id: string;
  tenant_id: string;

  customer_phone: string | null;

  start_time: Date | string;
  end_time: Date | string | null;
};

type LocationRow = {
  latitude: number | string | null;
  longitude: number | string | null;
};

type RouteNeighborRow = {
  appointment_id: string;

  start_time: Date | string;
  end_time: Date | string | null;

  latitude: number | string | null;
  longitude: number | string | null;
};

type CandidateScoreBreakdown = {
  incrementalDistanceKm: number | null;
  distancePenalty: number;

  appointmentCount: number;
  assignedMinutes: number;
  workloadPenalty: number;

  previousCustomerResource: boolean;
  continuityBonus: number;

  totalScore: number;
};

type Candidate = {
  resource: FieldOperationResource;

  eligible: boolean;
  rejectionReason: string | null;

  score: CandidateScoreBreakdown;
};

export type AutomaticResourceAssignmentResult = {
  status:
    | "assigned"
    | "already_assigned"
    | "appointment_not_found"
    | "no_active_resources"
    | "no_eligible_resources";

  appointmentId: string;

  resourceId: string | null;
  resourceName: string | null;

  score: number | null;
  reason: string;

  candidatesEvaluated: number;
  candidatesRejected: number;
};

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

function normalize(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
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
  value: Date | string | null,
  fieldName: string
): Date {
  if (!value) {
    throw new Error(
      `FIELD_OPERATIONS_REQUIRED_FIELD:${fieldName}`
    );
  }

  const parsed =
    value instanceof Date
      ? value
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
  const timezone = String(
    resource.timezone ?? ""
  ).trim();

  return timezone || "America/New_York";
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
  ): number => {
    return degrees * Math.PI / 180;
  };

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

async function getAppointment(
  tenantId: string,
  appointmentId: string
): Promise<AppointmentRow | null> {
  const { rows } =
    await pool.query<AppointmentRow>(
      `
      SELECT
        id,
        tenant_id,
        customer_phone,
        start_time,
        end_time
      FROM appointments
      WHERE tenant_id = $1
        AND id = $2
      LIMIT 1
      `,
      [
        tenantId,
        appointmentId,
      ]
    );

  return rows[0] ?? null;
}

async function getAppointmentLocation(
  tenantId: string,
  appointmentId: string
): Promise<LocationRow | null> {
  const { rows } =
    await pool.query<LocationRow>(
      `
      SELECT
        latitude,
        longitude
      FROM appointment_locations
      WHERE tenant_id = $1
        AND appointment_id = $2
        AND location_type = 'service'
      LIMIT 1
      `,
      [
        tenantId,
        appointmentId,
      ]
    );

  return rows[0] ?? null;
}

async function hasTimeConflict(input: {
  tenantId: string;
  appointmentId: string;
  resourceId: string;
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
          ON a.tenant_id = ara.tenant_id
         AND a.id = ara.appointment_id

        WHERE ara.tenant_id = $1
          AND ara.resource_id = $2
          AND ara.appointment_id <> $3

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
        input.appointmentId,
        ACTIVE_ASSIGNMENT_STATUSES,
        input.startAt.toISOString(),
        input.endAt.toISOString(),
        DEFAULT_APPOINTMENT_DURATION_MINUTES,
      ]
    );

  return Boolean(
    rows[0]?.conflict
  );
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
        ON a.tenant_id = ara.tenant_id
       AND a.id = ara.appointment_id

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
            $4::timestamptz
              AT TIME ZONE $6
          )
          AT TIME ZONE $6
        )

        AND a.start_time < (
          (
            DATE_TRUNC(
              'day',
              $4::timestamptz
                AT TIME ZONE $6
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
    appointmentCount: Number(
      rows[0]?.appointment_count ?? 0
    ),

    assignedMinutes: Number(
      rows[0]?.assigned_minutes ?? 0
    ),
  };
}

async function getPreviousRouteNeighbor(input: {
  tenantId: string;
  appointmentId: string;
  resourceId: string;
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
        ON a.tenant_id = ara.tenant_id
       AND a.id = ara.appointment_id

      LEFT JOIN appointment_locations al
        ON al.tenant_id = a.tenant_id
       AND al.appointment_id = a.id
       AND al.location_type = 'service'

      WHERE ara.tenant_id = $1
        AND ara.resource_id = $2
        AND ara.appointment_id <> $3

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
        input.appointmentId,
        ACTIVE_ASSIGNMENT_STATUSES,
        input.startAt.toISOString(),
        DEFAULT_APPOINTMENT_DURATION_MINUTES,
      ]
    );

  return rows[0] ?? null;
}

async function getNextRouteNeighbor(input: {
  tenantId: string;
  appointmentId: string;
  resourceId: string;
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
        ON a.tenant_id = ara.tenant_id
       AND a.id = ara.appointment_id

      LEFT JOIN appointment_locations al
        ON al.tenant_id = a.tenant_id
       AND al.appointment_id = a.id
       AND al.location_type = 'service'

      WHERE ara.tenant_id = $1
        AND ara.resource_id = $2
        AND ara.appointment_id <> $3

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
        input.appointmentId,
        ACTIVE_ASSIGNMENT_STATUSES,
        input.endAt.toISOString(),
      ]
    );

  return rows[0] ?? null;
}

async function wasPreviousResourceForCustomer(input: {
  tenantId: string;
  appointmentId: string;
  resourceId: string;
  customerPhone: string | null;
  startAt: Date;
}): Promise<boolean> {
  const customerPhone = String(
    input.customerPhone ?? ""
  ).trim();

  if (!customerPhone) {
    return false;
  }

  const { rows } =
    await pool.query<{ matched: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1

        FROM appointment_resource_assignments ara

        INNER JOIN appointments a
          ON a.tenant_id = ara.tenant_id
         AND a.id = ara.appointment_id

        WHERE ara.tenant_id = $1
          AND ara.resource_id = $2
          AND ara.appointment_id <> $3

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
        input.appointmentId,
        ACTIVE_ASSIGNMENT_STATUSES,
        customerPhone,
        input.startAt.toISOString(),
      ]
    );

  return Boolean(
    rows[0]?.matched
  );
}

function coordinatesFromNeighbor(
  neighbor: RouteNeighborRow | null
): {
  latitude: number;
  longitude: number;
} | null {
  const latitude = numberOrNull(
    neighbor?.latitude
  );

  const longitude = numberOrNull(
    neighbor?.longitude
  );

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
    ) ?? (
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

async function evaluateCandidate(input: {
  tenantId: string;
  appointmentId: string;

  appointment: AppointmentRow;
  resource: FieldOperationResource;

  appointmentLatitude: number | null;
  appointmentLongitude: number | null;

  startAt: Date;
  endAt: Date;
}): Promise<Candidate> {
  const emptyScore: CandidateScoreBreakdown = {
    incrementalDistanceKm: null,
    distancePenalty: 0,

    appointmentCount: 0,
    assignedMinutes: 0,
    workloadPenalty: 0,

    previousCustomerResource: false,
    continuityBonus: 0,

    totalScore:
      Number.POSITIVE_INFINITY,
  };

  const conflict =
    await hasTimeConflict({
      tenantId: input.tenantId,
      appointmentId: input.appointmentId,
      resourceId: input.resource.id,
      startAt: input.startAt,
      endAt: input.endAt,
    });

  if (conflict) {
    return {
      resource: input.resource,
      eligible: false,
      rejectionReason: "TIME_CONFLICT",
      score: emptyScore,
    };
  }

  const timezone =
    normalizeTimezone(
      input.resource
    );

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
      appointmentId: input.appointmentId,
      resourceId: input.resource.id,
      startAt: input.startAt,
    }),

    getNextRouteNeighbor({
      tenantId: input.tenantId,
      appointmentId: input.appointmentId,
      resourceId: input.resource.id,
      endAt: input.endAt,
    }),

    wasPreviousResourceForCustomer({
      tenantId: input.tenantId,
      appointmentId: input.appointmentId,
      resourceId: input.resource.id,
      customerPhone:
        input.appointment.customer_phone,
      startAt: input.startAt,
    }),
  ]);

  const incrementalDistanceKm =
    calculateIncrementalDistanceKm({
      resource: input.resource,

      appointmentLatitude:
        input.appointmentLatitude,

      appointmentLongitude:
        input.appointmentLongitude,

      previousNeighbor,
      nextNeighbor,
    });

  const distancePenalty =
    incrementalDistanceKm === null
      ? DISPATCH_WEIGHTS
          .missingDistancePenalty
      : incrementalDistanceKm *
          DISPATCH_WEIGHTS.distancePerKm;

  const workloadPenalty =
    load.appointmentCount *
      DISPATCH_WEIGHTS
        .appointmentCountPenalty +
    (
      load.assignedMinutes / 60
    ) *
      DISPATCH_WEIGHTS
        .assignedHourPenalty;

  const continuityBonus =
    previousCustomerResource
      ? DISPATCH_WEIGHTS
          .customerContinuityBonus
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

export async function automaticallyAssignBestResource(
  input: {
    tenantId: string;
    appointmentId: string;
  }
): Promise<AutomaticResourceAssignmentResult> {
  const tenantId = requiredString(
    input.tenantId,
    "tenantId"
  );

  const appointmentId = requiredString(
    input.appointmentId,
    "appointmentId"
  );

  const existingAssignments =
    await listResourceAssignments({
      tenantId,
      appointmentId,
    });

  const existingActive =
    existingAssignments.find(
      (assignment) =>
        ACTIVE_ASSIGNMENT_STATUSES.includes(
          normalize(
            assignment.assignmentStatus
          )
        )
    );

  if (existingActive) {
    return {
      status: "already_assigned",
      appointmentId,

      resourceId:
        existingActive.resourceId,

      resourceName: null,

      score: null,

      reason:
        "ACTIVE_ASSIGNMENT_ALREADY_EXISTS",

      candidatesEvaluated: 0,
      candidatesRejected: 0,
    };
  }

  const appointment =
    await getAppointment(
      tenantId,
      appointmentId
    );

  if (!appointment) {
    return {
      status:
        "appointment_not_found",

      appointmentId,

      resourceId: null,
      resourceName: null,

      score: null,

      reason:
        "APPOINTMENT_NOT_FOUND",

      candidatesEvaluated: 0,
      candidatesRejected: 0,
    };
  }

  const resources =
    await listFieldOperationResources({
      tenantId,
      active: true,
    });

  if (resources.length === 0) {
    return {
      status:
        "no_active_resources",

      appointmentId,

      resourceId: null,
      resourceName: null,

      score: null,

      reason:
        "NO_ACTIVE_RESOURCES",

      candidatesEvaluated: 0,
      candidatesRejected: 0,
    };
  }

  const startAt = toDate(
    appointment.start_time,
    "appointment.start_time"
  );

  const endAt =
    appointment.end_time
      ? toDate(
          appointment.end_time,
          "appointment.end_time"
        )
      : new Date(
          startAt.getTime() +
            DEFAULT_APPOINTMENT_DURATION_MINUTES *
              60 *
              1000
        );

  const location =
    await getAppointmentLocation(
      tenantId,
      appointmentId
    );

  const appointmentLatitude =
    numberOrNull(
      location?.latitude
    );

  const appointmentLongitude =
    numberOrNull(
      location?.longitude
    );

  const evaluations: Candidate[] = [];

  // Se evalúan secuencialmente para no disparar decenas
  // de consultas simultáneas por una sola cita.
  for (const resource of resources) {
    const candidate =
      await evaluateCandidate({
        tenantId,
        appointmentId,
        appointment,
        resource,

        appointmentLatitude,
        appointmentLongitude,

        startAt,
        endAt,
      });

    evaluations.push(candidate);
  }

  const eligible = evaluations
    .filter(
      (candidate) =>
        candidate.eligible
    )
    .sort(
      (candidateA, candidateB) =>
        candidateA.score.totalScore -
          candidateB.score.totalScore ||
        candidateA.resource.name.localeCompare(
          candidateB.resource.name
        ) ||
        candidateA.resource.id.localeCompare(
          candidateB.resource.id
        )
    );

  const best = eligible[0];

  const rejectedCount =
    evaluations.length -
    eligible.length;

  if (!best) {
    return {
      status:
        "no_eligible_resources",

      appointmentId,

      resourceId: null,
      resourceName: null,

      score: null,

      reason:
        "ALL_ACTIVE_RESOURCES_REJECTED",

      candidatesEvaluated:
        evaluations.length,

      candidatesRejected:
        rejectedCount,
    };
  }

  await saveResourceAssignment({
    tenantId,
    appointmentId,

    resourceId:
      best.resource.id,

    assignmentRole: "primary",
    assignmentStatus: "assigned",

    metadata: {
      assignmentSource:
        "dispatch_engine",

      assignedAt:
        new Date().toISOString(),

      scoringVersion:
        "dispatch_route_load_continuity_v1",

      score: Number(
        best.score.totalScore.toFixed(4)
      ),

      scoreBreakdown: {
        incrementalDistanceKm:
          best.score
            .incrementalDistanceKm === null
            ? null
            : Number(
                best.score
                  .incrementalDistanceKm
                  .toFixed(3)
              ),

        distancePenalty: Number(
          best.score
            .distancePenalty
            .toFixed(4)
        ),

        appointmentCountBeforeAssignment:
          best.score.appointmentCount,

        assignedMinutesBeforeAssignment:
          best.score.assignedMinutes,

        workloadPenalty: Number(
          best.score
            .workloadPenalty
            .toFixed(4)
        ),

        previousCustomerResource:
          best.score
            .previousCustomerResource,

        continuityBonus: Number(
          best.score
            .continuityBonus
            .toFixed(4)
        ),
      },

      candidatesEvaluated:
        evaluations.length,

      candidatesRejected:
        rejectedCount,

      rejectedCandidates:
        evaluations
          .filter(
            (candidate) =>
              !candidate.eligible
          )
          .map(
            (candidate) => ({
              resourceId:
                candidate.resource.id,

              reason:
                candidate.rejectionReason,
            })
          ),
    },
  });

  return {
    status: "assigned",

    appointmentId,

    resourceId:
      best.resource.id,

    resourceName:
      best.resource.name,

    score: Number(
      best.score.totalScore.toFixed(4)
    ),

    reason:
      "BEST_DISPATCH_CANDIDATE_SELECTED",

    candidatesEvaluated:
      evaluations.length,

    candidatesRejected:
      rejectedCount,
  };
}