// src/modules/field-operations/services/automaticResourceAssignment.service.ts

import pool from "../../../lib/db";
import { listFieldOperationResources } from "../repositories/fieldResources.repo";
import {
  listResourceAssignments,
  saveResourceAssignment,
} from "../repositories/resourceAssignments.repo";
import type { FieldOperationResource } from "../domain/fieldOperations.types";

type AppointmentRow = {
  id: string;
  tenant_id: string;
  service_id: string | null;
  service_name: string | null;
  start_time: Date | string;
  end_time: Date | string | null;
};

type LocationRow = {
  latitude: number | string | null;
  longitude: number | string | null;
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

type Candidate = {
  resource: FieldOperationResource;
  eligible: boolean;
  rejectionReason: string | null;
  distanceKm: number | null;
  appointmentCount: number;
  assignedMinutes: number;
  score: number;
};

const ACTIVE_ASSIGNMENT_STATUSES = [
  "assigned",
  "accepted",
  "confirmed",
  "en_route",
  "in_progress",
];

function requiredString(value: unknown, fieldName: string): string {
  const result = String(value ?? "").trim();
  if (!result) {
    throw new Error(`FIELD_OPERATIONS_REQUIRED_FIELD:${fieldName}`);
  }
  return result;
}

function normalize(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toDate(value: Date | string | null, fieldName: string): Date {
  if (!value) {
    throw new Error(`FIELD_OPERATIONS_REQUIRED_FIELD:${fieldName}`);
  }

  const parsed = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`FIELD_OPERATIONS_INVALID_DATE:${fieldName}`);
  }

  return parsed;
}

function haversineDistanceKm(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number
): number {
  const radiusKm = 6371;
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLatitude = radians(latitudeB - latitudeA);
  const deltaLongitude = radians(longitudeB - longitudeA);

  const value =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(radians(latitudeA)) *
      Math.cos(radians(latitudeB)) *
      Math.sin(deltaLongitude / 2) ** 2;

  return (
    2 *
    radiusKm *
    Math.atan2(Math.sqrt(value), Math.sqrt(1 - value))
  );
}

function capabilityMatches(
  resource: FieldOperationResource,
  appointment: AppointmentRow
): boolean {
  const capabilities = Array.isArray(resource.capabilities)
    ? resource.capabilities
    : [];

  if (capabilities.length === 0) return true;

  const serviceTokens = new Set(
    [appointment.service_id, appointment.service_name]
      .map(normalize)
      .filter(Boolean)
  );

  if (serviceTokens.size === 0) return true;

  let recognized = false;

  for (const capability of capabilities) {
    if (typeof capability === "string") {
      recognized = true;
      if (serviceTokens.has(normalize(capability))) return true;
      continue;
    }

    if (
      capability &&
      typeof capability === "object" &&
      !Array.isArray(capability)
    ) {
      const item = capability as Record<string, unknown>;
      const values = [
        item.serviceId,
        item.service_id,
        item.serviceName,
        item.service_name,
        item.id,
        item.name,
        item.value,
        item.key,
      ]
        .map(normalize)
        .filter(Boolean);

      if (values.length > 0) recognized = true;
      if (values.some((value) => serviceTokens.has(value))) return true;
    }
  }

  // Unknown metadata structures remain permissive.
  return !recognized;
}

async function getAppointment(
  tenantId: string,
  appointmentId: string
): Promise<AppointmentRow | null> {
  const { rows } = await pool.query<AppointmentRow>(
    `
    SELECT
      id,
      tenant_id,
      service_id,
      service_name,
      start_time,
      end_time
    FROM appointments
    WHERE tenant_id = $1
      AND id = $2
    LIMIT 1
    `,
    [tenantId, appointmentId]
  );

  return rows[0] ?? null;
}

async function getAppointmentLocation(
  tenantId: string,
  appointmentId: string
): Promise<LocationRow | null> {
  const { rows } = await pool.query<LocationRow>(
    `
    SELECT latitude, longitude
    FROM appointment_locations
    WHERE tenant_id = $1
      AND appointment_id = $2
      AND location_type = 'service'
    LIMIT 1
    `,
    [tenantId, appointmentId]
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
  const { rows } = await pool.query<{ conflict: boolean }>(
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
        AND ara.assignment_status = ANY($4::text[])
        AND COALESCE(a.status, '') <> 'cancelled'
        AND a.start_time < $6
        AND COALESCE(
          a.end_time,
          a.start_time + INTERVAL '60 minutes'
        ) > $5
    ) AS conflict
    `,
    [
      input.tenantId,
      input.resourceId,
      input.appointmentId,
      ACTIVE_ASSIGNMENT_STATUSES,
      input.startAt.toISOString(),
      input.endAt.toISOString(),
    ]
  );

  return Boolean(rows[0]?.conflict);
}

async function getDailyLoad(input: {
  tenantId: string;
  resourceId: string;
  startAt: Date;
}): Promise<{ appointmentCount: number; assignedMinutes: number }> {
  const startOfDay = new Date(input.startAt);
  startOfDay.setUTCHours(0, 0, 0, 0);

  const endOfDay = new Date(startOfDay);
  endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);

  const { rows } = await pool.query<{
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
                a.start_time + INTERVAL '60 minutes'
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
      AND ara.assignment_status = ANY($3::text[])
      AND COALESCE(a.status, '') <> 'cancelled'
      AND a.start_time >= $4
      AND a.start_time < $5
    `,
    [
      input.tenantId,
      input.resourceId,
      ACTIVE_ASSIGNMENT_STATUSES,
      startOfDay.toISOString(),
      endOfDay.toISOString(),
    ]
  );

  return {
    appointmentCount: Number(rows[0]?.appointment_count ?? 0),
    assignedMinutes: Number(rows[0]?.assigned_minutes ?? 0),
  };
}

async function getPreviousStopCoordinates(input: {
  tenantId: string;
  appointmentId: string;
  resourceId: string;
  startAt: Date;
}): Promise<{ latitude: number; longitude: number } | null> {
  const { rows } = await pool.query<LocationRow>(
    `
    SELECT al.latitude, al.longitude
    FROM appointment_resource_assignments ara
    INNER JOIN appointments a
      ON a.tenant_id = ara.tenant_id
     AND a.id = ara.appointment_id
    INNER JOIN appointment_locations al
      ON al.tenant_id = a.tenant_id
     AND al.appointment_id = a.id
     AND al.location_type = 'service'
    WHERE ara.tenant_id = $1
      AND ara.resource_id = $2
      AND ara.appointment_id <> $3
      AND ara.assignment_status = ANY($4::text[])
      AND COALESCE(a.status, '') <> 'cancelled'
      AND COALESCE(
        a.end_time,
        a.start_time + INTERVAL '60 minutes'
      ) <= $5
      AND al.latitude IS NOT NULL
      AND al.longitude IS NOT NULL
    ORDER BY COALESCE(
      a.end_time,
      a.start_time + INTERVAL '60 minutes'
    ) DESC
    LIMIT 1
    `,
    [
      input.tenantId,
      input.resourceId,
      input.appointmentId,
      ACTIVE_ASSIGNMENT_STATUSES,
      input.startAt.toISOString(),
    ]
  );

  const latitude = numberOrNull(rows[0]?.latitude);
  const longitude = numberOrNull(rows[0]?.longitude);

  if (latitude === null || longitude === null) return null;

  return { latitude, longitude };
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
  if (!capabilityMatches(input.resource, input.appointment)) {
    return {
      resource: input.resource,
      eligible: false,
      rejectionReason: "CAPABILITY_MISMATCH",
      distanceKm: null,
      appointmentCount: 0,
      assignedMinutes: 0,
      score: Number.POSITIVE_INFINITY,
    };
  }

  if (
    await hasTimeConflict({
      tenantId: input.tenantId,
      appointmentId: input.appointmentId,
      resourceId: input.resource.id,
      startAt: input.startAt,
      endAt: input.endAt,
    })
  ) {
    return {
      resource: input.resource,
      eligible: false,
      rejectionReason: "TIME_CONFLICT",
      distanceKm: null,
      appointmentCount: 0,
      assignedMinutes: 0,
      score: Number.POSITIVE_INFINITY,
    };
  }

  const load = await getDailyLoad({
    tenantId: input.tenantId,
    resourceId: input.resource.id,
    startAt: input.startAt,
  });

  const previousStop = await getPreviousStopCoordinates({
    tenantId: input.tenantId,
    appointmentId: input.appointmentId,
    resourceId: input.resource.id,
    startAt: input.startAt,
  });

  const anchorLatitude =
    previousStop?.latitude ?? input.resource.startLatitude;

  const anchorLongitude =
    previousStop?.longitude ?? input.resource.startLongitude;

  let distanceKm: number | null = null;

  if (
    input.appointmentLatitude !== null &&
    input.appointmentLongitude !== null &&
    anchorLatitude !== null &&
    anchorLongitude !== null
  ) {
    distanceKm = haversineDistanceKm(
      anchorLatitude,
      anchorLongitude,
      input.appointmentLatitude,
      input.appointmentLongitude
    );
  }

  // Lower score wins. Distance is strongest, then load balancing.
  const score =
    (distanceKm === null ? 50 : distanceKm * 10) +
    load.appointmentCount * 8 +
    (load.assignedMinutes / 60) * 3;

  return {
    resource: input.resource,
    eligible: true,
    rejectionReason: null,
    distanceKm,
    appointmentCount: load.appointmentCount,
    assignedMinutes: load.assignedMinutes,
    score,
  };
}

export async function automaticallyAssignBestResource(input: {
  tenantId: string;
  appointmentId: string;
}): Promise<AutomaticResourceAssignmentResult> {
  const tenantId = requiredString(input.tenantId, "tenantId");
  const appointmentId = requiredString(
    input.appointmentId,
    "appointmentId"
  );

  const existingAssignments = await listResourceAssignments({
    tenantId,
    appointmentId,
  });

  const existingActive = existingAssignments.find((assignment) =>
    ACTIVE_ASSIGNMENT_STATUSES.includes(
      normalize(assignment.assignmentStatus)
    )
  );

  if (existingActive) {
    return {
      status: "already_assigned",
      appointmentId,
      resourceId: existingActive.resourceId,
      resourceName: null,
      score: null,
      reason: "ACTIVE_ASSIGNMENT_ALREADY_EXISTS",
      candidatesEvaluated: 0,
      candidatesRejected: 0,
    };
  }

  const appointment = await getAppointment(tenantId, appointmentId);

  if (!appointment) {
    return {
      status: "appointment_not_found",
      appointmentId,
      resourceId: null,
      resourceName: null,
      score: null,
      reason: "APPOINTMENT_NOT_FOUND",
      candidatesEvaluated: 0,
      candidatesRejected: 0,
    };
  }

  const resources = await listFieldOperationResources({
    tenantId,
    active: true,
  });

  if (resources.length === 0) {
    return {
      status: "no_active_resources",
      appointmentId,
      resourceId: null,
      resourceName: null,
      score: null,
      reason: "NO_ACTIVE_RESOURCES",
      candidatesEvaluated: 0,
      candidatesRejected: 0,
    };
  }

  const startAt = toDate(appointment.start_time, "appointment.start_time");
  const endAt = appointment.end_time
    ? toDate(appointment.end_time, "appointment.end_time")
    : new Date(startAt.getTime() + 60 * 60 * 1000);

  const location = await getAppointmentLocation(tenantId, appointmentId);
  const appointmentLatitude = numberOrNull(location?.latitude);
  const appointmentLongitude = numberOrNull(location?.longitude);

  const evaluations = await Promise.all(
    resources.map((resource) =>
      evaluateCandidate({
        tenantId,
        appointmentId,
        appointment,
        resource,
        appointmentLatitude,
        appointmentLongitude,
        startAt,
        endAt,
      })
    )
  );

  const eligible = evaluations
    .filter((candidate) => candidate.eligible)
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.resource.name.localeCompare(b.resource.name)
    );

  const best = eligible[0];
  const rejectedCount = evaluations.length - eligible.length;

  if (!best) {
    return {
      status: "no_eligible_resources",
      appointmentId,
      resourceId: null,
      resourceName: null,
      score: null,
      reason: "ALL_ACTIVE_RESOURCES_REJECTED",
      candidatesEvaluated: evaluations.length,
      candidatesRejected: rejectedCount,
    };
  }

  await saveResourceAssignment({
    tenantId,
    appointmentId,
    resourceId: best.resource.id,
    assignmentRole: "primary",
    assignmentStatus: "assigned",
    metadata: {
      assignmentSource: "automatic_best_resource",
      assignedAt: new Date().toISOString(),
      scoringVersion: "distance_conflict_load_v1",
      score: Number(best.score.toFixed(4)),
      distanceKm:
        best.distanceKm === null
          ? null
          : Number(best.distanceKm.toFixed(3)),
      appointmentCountBeforeAssignment: best.appointmentCount,
      assignedMinutesBeforeAssignment: best.assignedMinutes,
      candidatesEvaluated: evaluations.length,
      candidatesRejected: rejectedCount,
    },
  });

  return {
    status: "assigned",
    appointmentId,
    resourceId: best.resource.id,
    resourceName: best.resource.name,
    score: Number(best.score.toFixed(4)),
    reason: "BEST_ELIGIBLE_RESOURCE_SELECTED",
    candidatesEvaluated: evaluations.length,
    candidatesRejected: rejectedCount,
  };
}