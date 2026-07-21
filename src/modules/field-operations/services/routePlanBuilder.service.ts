// src/modules/field-operations/services/routePlanBuilder.service.ts

import pool from "../../../lib/db";

import {
  getFieldOperationResourceById,
} from "../repositories/fieldResources.repo";

import {
  saveRoutePlan,
} from "../repositories/routePlans.repo";

import {
  geocodeAppointmentLocation,
} from "./appointmentGeocoding.service";

import type {
  RoutePlan,
  RoutePlanMode,
} from "../domain/fieldOperations.types";

import type {
  RoutingStopInput,
} from "../providers/routingProvider.types";

import {
  getAppointmentSettings,
} from "../../../lib/appointments/getAppointmentSettings";

import {
  validateFieldServiceArea,
} from "./fieldServiceArea.service";

type RouteAppointmentRow = {
  appointment_id: string;

  service_id: string | null;
  service_name: string | null;

  customer_name: string | null;
  customer_phone: string | null;

  start_time: Date | string;
  end_time: Date | string;

  appointment_status: string;

  location_id: string | null;
  formatted_address: string | null;

  latitude: number | string | null;
  longitude: number | string | null;

  geocoding_status: string | null;

  assignment_role: string;
  assignment_status: string;
};

export type SkippedRouteAppointment = {
  appointmentId: string;

  reason:
    | "LOCATION_NOT_FOUND"
    | "LOCATION_NOT_GEOCODED"
    | "GEOCODING_NOT_FOUND"
    | "GEOCODING_FAILED"
    | "INVALID_COORDINATES"
    | "INVALID_APPOINTMENT_TIME"
    | "FIELD_SERVICE_AREA_NOT_CONFIGURED"
    | "FIELD_SERVICE_LOCATION_OUTSIDE_RADIUS";

  formattedAddress: string | null;
  error?: string | null;

  distanceMiles?: number | null;
  allowedRadiusMiles?: number | null;
};

export type BuildRoutePlanInput = {
  tenantId: string;
  resourceId: string;
  serviceDate: string;
  mode?: RoutePlanMode;
  geocodeMissingLocations?: boolean;
  geocodingLanguage?: string;
  geocodingRegion?: string;
};

export type BuildRoutePlanResult = {
  routePlan: RoutePlan;
  stops: RoutingStopInput[];
  skippedAppointments: SkippedRouteAppointment[];
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

function normalizeServiceDate(
  value: unknown
): string {
  const serviceDate = requiredString(
    value,
    "serviceDate"
  );

  const match =
    /^(\d{4})-(\d{2})-(\d{2})$/.exec(serviceDate);

  if (!match) {
    throw new Error(
      "FIELD_OPERATIONS_INVALID_SERVICE_DATE"
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const parsed = new Date(
    Date.UTC(year, month - 1, day)
  );

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(
      "FIELD_OPERATIONS_INVALID_SERVICE_DATE"
    );
  }

  return serviceDate;
}

function toIsoString(
  value: Date | string
): string | null {
  const parsed =
    value instanceof Date
      ? value
      : new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function parseCoordinate(
  value: number | string | null,
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

function calculateServiceDurationSeconds(
  startISO: string,
  endISO: string
): number {
  const start = new Date(startISO);
  const end = new Date(endISO);

  const durationMilliseconds =
    end.getTime() - start.getTime();

  if (
    !Number.isFinite(durationMilliseconds) ||
    durationMilliseconds < 0
  ) {
    return 0;
  }

  return Math.round(
    durationMilliseconds / 1000
  );
}

export async function buildRoutePlan(
  input: BuildRoutePlanInput
): Promise<BuildRoutePlanResult> {
  const tenantId = requiredString(
    input.tenantId,
    "tenantId"
  );

  const resourceId = requiredString(
    input.resourceId,
    "resourceId"
  );

  const serviceDate = normalizeServiceDate(
    input.serviceDate
  );

  const resource =
    await getFieldOperationResourceById({
      tenantId,
      resourceId,
    });

  if (!resource) {
    throw new Error(
      "FIELD_OPERATIONS_RESOURCE_NOT_FOUND"
    );
  }

  if (!resource.active) {
    throw new Error(
      "FIELD_OPERATIONS_RESOURCE_INACTIVE"
    );
  }

  const appointmentSettings =
    await getAppointmentSettings(tenantId);

  const timezone =
    String(
      resource.timezone ??
        appointmentSettings.timezone ??
        ""
    ).trim() || "America/New_York";

  const bufferAfterSeconds = Math.max(
    0,
    Math.round(
      Number(appointmentSettings.buffer_min || 0) * 60
    )
  );

  const { rows } =
    await pool.query<RouteAppointmentRow>(
      `
      SELECT
        a.id::text AS appointment_id,

        a.service_id::text AS service_id,
        s.name AS service_name,

        a.customer_name,
        a.customer_phone,

        a.start_time,

        COALESCE(
          a.end_time,
          a.start_time + INTERVAL '60 minutes'
        ) AS end_time,

        COALESCE(
          a.status,
          'confirmed'
        ) AS appointment_status,

        al.id AS location_id,
        al.formatted_address,

        al.latitude,
        al.longitude,

        al.geocoding_status,

        ara.assignment_role,
        ara.assignment_status

      FROM appointment_resource_assignments ara

      INNER JOIN appointments a
        ON a.id::text = ara.appointment_id
      AND a.tenant_id::text = ara.tenant_id

      LEFT JOIN services s
        ON s.id = a.service_id

      LEFT JOIN appointment_locations al
        ON al.tenant_id = ara.tenant_id
      AND al.appointment_id = ara.appointment_id
      AND al.location_type = 'service'

      WHERE ara.tenant_id = $1
        AND ara.resource_id = $2

        AND ara.assignment_status = ANY(
          ARRAY[
            'assigned',
            'accepted',
            'confirmed',
            'dispatched',
            'en_route',
            'arrived',
            'in_progress'
          ]::text[]
        )

        AND COALESCE(
          LOWER(a.status),
          ''
        ) <> 'cancelled'

        AND (
          a.start_time AT TIME ZONE $4
        )::date = $3::date

      ORDER BY
        a.start_time ASC,
        ara.created_at ASC
      `,
      [
        tenantId,
        resourceId,
        serviceDate,
        timezone,
      ]
    );

  console.log(
    "[FIELD_OPERATIONS][ROUTE_BUILDER_APPOINTMENTS_LOADED]",
    {
      version: "route_builder_v2",
      tenantId,
      resourceId,
      serviceDate,
      timezone,
      appointmentsFound: rows.length,
      appointments: rows.map((row) => ({
        appointmentId: row.appointment_id,
        startTime: row.start_time,
        endTime: row.end_time,
        assignmentStatus: row.assignment_status,
        formattedAddress: row.formatted_address,
        latitude: row.latitude,
        longitude: row.longitude,
        geocodingStatus: row.geocoding_status,
      })),
    }
  );

  const stops: RoutingStopInput[] = [];
  const skippedAppointments:
    SkippedRouteAppointment[] = [];

  for (const row of rows) {
    if (!row.location_id) {
      skippedAppointments.push({
        appointmentId: row.appointment_id,
        reason: "LOCATION_NOT_FOUND",
        formattedAddress:
          row.formatted_address ?? null,
      });

      continue;
    }

    let latitude = parseCoordinate(
      row.latitude,
      -90,
      90
    );

    let longitude = parseCoordinate(
      row.longitude,
      -180,
      180
    );

    if (
      (latitude === null || longitude === null) &&
      input.geocodeMissingLocations !== false &&
      row.formatted_address
    ) {
      const geocoding =
        await geocodeAppointmentLocation({
          tenantId,
          appointmentId: row.appointment_id,
          language: input.geocodingLanguage,
          region: input.geocodingRegion,
        });

      if (
        geocoding.status === "geocoded" ||
        geocoding.status === "already_geocoded"
      ) {
        latitude =
          geocoding.geocoding?.latitude ?? null;
        longitude =
          geocoding.geocoding?.longitude ?? null;

        if (geocoding.geocoding) {
          row.formatted_address =
            geocoding.geocoding.formattedAddress;
        }
      } else {
        skippedAppointments.push({
          appointmentId: row.appointment_id,
          reason:
            geocoding.status === "not_found"
              ? "GEOCODING_NOT_FOUND"
              : "GEOCODING_FAILED",
          formattedAddress:
            row.formatted_address,
          error: geocoding.error,
        });

        continue;
      }
    }

    if (
      latitude === null ||
      longitude === null
    ) {
      skippedAppointments.push({
        appointmentId: row.appointment_id,
        reason:
          row.geocoding_status === "pending"
            ? "LOCATION_NOT_GEOCODED"
            : "INVALID_COORDINATES",
        formattedAddress:
          row.formatted_address ?? null,
      });

      continue;
    }

    const serviceAreaValidation =
      await validateFieldServiceArea({
        tenantId,
        latitude,
        longitude,
      });

    if (!serviceAreaValidation.allowed) {
      skippedAppointments.push({
        appointmentId:
          row.appointment_id,

        reason:
          serviceAreaValidation.reason ===
          "FIELD_SERVICE_AREA_NOT_CONFIGURED"
            ? "FIELD_SERVICE_AREA_NOT_CONFIGURED"
            : "FIELD_SERVICE_LOCATION_OUTSIDE_RADIUS",

        formattedAddress:
          row.formatted_address ?? null,

        distanceMiles:
          serviceAreaValidation.distanceMiles,

        allowedRadiusMiles:
          serviceAreaValidation.radiusMiles,
      });

      continue;
    }

    const scheduledStartAt = toIsoString(
      row.start_time
    );

    const scheduledEndAt = toIsoString(
      row.end_time
    );

    if (
      !scheduledStartAt ||
      !scheduledEndAt
    ) {
      skippedAppointments.push({
        appointmentId: row.appointment_id,
        reason: "INVALID_APPOINTMENT_TIME",
        formattedAddress:
          row.formatted_address ?? null,
      });

      continue;
    }

    stops.push({
      appointmentId: row.appointment_id,
      locationId: row.location_id,
      latitude,
      longitude,
      scheduledStartAt,
      scheduledEndAt,
      serviceDurationSeconds:
        calculateServiceDurationSeconds(
          scheduledStartAt,
          scheduledEndAt
        ),
      bufferAfterSeconds,
      isLocked: false,
      metadata: {
        serviceId: row.service_id,
        serviceName: row.service_name,
        customerName: row.customer_name,
        customerPhone: row.customer_phone,
        formattedAddress:
          row.formatted_address,
        appointmentStatus:
          row.appointment_status,
        assignmentRole:
          row.assignment_role,
        assignmentStatus:
          row.assignment_status,
        bufferAfterSeconds,
        bufferAfterMinutes:
          Math.round(bufferAfterSeconds / 60),
        fieldServiceAreaValidationApplied:
          serviceAreaValidation.validationApplied,

        fieldServiceDistanceMiles:
          serviceAreaValidation.distanceMiles,

        fieldServiceRadiusMiles:
          serviceAreaValidation.radiusMiles,
      },
    });
  }

  const routePlan = await saveRoutePlan({
    tenantId,
    resourceId,
    serviceDate,
    mode: input.mode ?? "view_only",
    status: "draft",
    optimizationRequest: {
      source: "automatic_builder",
      timezone,
      geocodeMissingLocations:
        input.geocodeMissingLocations !== false,
      totalAppointments: rows.length,
      routableAppointments: stops.length,
      skippedAppointments:
        skippedAppointments.length,
    },
  });

  return {
    routePlan,
    stops,
    skippedAppointments,
  };
}