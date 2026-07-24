// src/modules/field-operations/services/routeFeasibility.service.ts

import pool from "../../../lib/db";

import {
  getFieldOperationResourceById,
} from "../repositories/fieldResources.repo";

import {
  LocalApproximateRoutingProvider,
} from "../providers/localApproximateRouting.provider";

import {
  calculateHaversineDistanceMeters,
  estimateDriveSeconds,
} from "../providers/geography";

import type {
  RoutingCoordinate,
  RoutingStopInput,
  RoutingStopOutput,
} from "../providers/routingProvider.types";

import {
  getAppointmentSettings,
} from "../../../lib/appointments/getAppointmentSettings";

const ACTIVE_ASSIGNMENT_STATUSES = [
  "assigned",
  "accepted",
  "confirmed",
  "dispatched",
  "en_route",
  "arrived",
  "in_progress",
];

type ExistingRouteAppointmentRow = {
  appointment_id: string;

  start_time: Date | string;
  end_time: Date | string | null;

  latitude: number | string | null;
  longitude: number | string | null;

  formatted_address: string | null;
};

export type CheckRouteFeasibilityInput = {
  tenantId: string;
  resourceId: string;

  startAt: Date | string;
  endAt: Date | string;

  latitude: number;
  longitude: number;

  formattedAddress?: string | null;

  excludedAppointmentId?: string | null;

  /**
   * Identificador temporal para la simulación.
   * No tiene que existir en la base de datos.
   */
  hypotheticalAppointmentId?: string | null;
};

export type RouteViolation = {
  appointmentId: string | null;

  scheduledStartAt: string | null;
  physicalArrivalAt: string | null;

  delaySeconds: number;

  isHypotheticalAppointment: boolean;
};

export type CheckRouteFeasibilityResult = {
  feasible: boolean;

  resourceId: string;

  violations: RouteViolation[];

  orderedStops: RoutingStopOutput[];

  totalDistanceMeters: number;
  totalDriveSeconds: number;

  reason:
    | "ROUTE_FEASIBLE"
    | "ROUTE_WOULD_CAUSE_DELAY"
    | "RESOURCE_NOT_FOUND"
    | "RESOURCE_INACTIVE"
    | "INVALID_COORDINATES";
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

function parseCoordinate(
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

function serviceDateForTimezone(
  date: Date,
  timezone: string
): string {
  const parts =
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);

  const year =
    parts.find(
      (part) => part.type === "year"
    )?.value;

  const month =
    parts.find(
      (part) => part.type === "month"
    )?.value;

  const day =
    parts.find(
      (part) => part.type === "day"
    )?.value;

  if (!year || !month || !day) {
    throw new Error(
      "FIELD_OPERATIONS_SERVICE_DATE_RESOLUTION_FAILED"
    );
  }

  return `${year}-${month}-${day}`;
}

function calculateServiceDurationSeconds(
  startAt: Date,
  endAt: Date
): number {
  return Math.max(
    0,
    Math.round(
      (
        endAt.getTime() -
        startAt.getTime()
      ) / 1000
    )
  );
}

function buildStartLocation(input: {
  latitude: number | null;
  longitude: number | null;
}): RoutingCoordinate | null {
  if (
    input.latitude === null ||
    input.longitude === null
  ) {
    return null;
  }

  return {
    latitude: input.latitude,
    longitude: input.longitude,
  };
}

async function loadExistingStops(input: {
  tenantId: string;
  resourceId: string;

  serviceDate: string;
  timezone: string;

  excludedAppointmentId: string | null;

  bufferAfterSeconds: number;
}): Promise<RoutingStopInput[]> {
  const { rows } =
    await pool.query<ExistingRouteAppointmentRow>(
      `
      SELECT
        a.id::text AS appointment_id,

        a.start_time,
        a.end_time,

        al.latitude,
        al.longitude,

        al.formatted_address

      FROM appointment_resource_assignments ara

      INNER JOIN appointments a
        ON a.tenant_id::text = ara.tenant_id
       AND a.id::text = ara.appointment_id

      INNER JOIN appointment_locations al
        ON al.tenant_id = ara.tenant_id
       AND al.appointment_id = ara.appointment_id
       AND al.location_type = 'service'

      WHERE ara.tenant_id = $1
        AND ara.resource_id = $2

        AND ara.assignment_status =
          ANY($3::text[])

        AND COALESCE(
          LOWER(a.status),
          ''
        ) <> 'cancelled'

        AND (
          $4::text IS NULL
          OR a.id::text <> $4
        )

        AND (
          a.start_time AT TIME ZONE $6
        )::date = $5::date

      ORDER BY
        a.start_time ASC,
        a.id ASC
      `,
      [
        input.tenantId,
        input.resourceId,
        ACTIVE_ASSIGNMENT_STATUSES,
        input.excludedAppointmentId,
        input.serviceDate,
        input.timezone,
      ]
    );

  const stops: RoutingStopInput[] = [];

  for (const row of rows) {
    const latitude =
      parseCoordinate(
        row.latitude,
        -90,
        90
      );

    const longitude =
      parseCoordinate(
        row.longitude,
        -180,
        180
      );

    if (
      latitude === null ||
      longitude === null
    ) {
      /*
       * Una cita existente sin coordenadas no puede participar
       * en una simulación física confiable.
       *
       * No se rechaza automáticamente todo el día porque eso
       * bloquearía reservas por datos históricos incompletos.
       */
      console.warn(
        "[FIELD_OPERATIONS][ROUTE_FEASIBILITY_STOP_SKIPPED]",
        {
          tenantId: input.tenantId,
          resourceId: input.resourceId,
          appointmentId:
            row.appointment_id,
          reason:
            "EXISTING_APPOINTMENT_WITHOUT_VALID_COORDINATES",
        }
      );

      continue;
    }

    const startAt =
      toDate(
        row.start_time,
        "existingAppointment.start_time"
      );

    const endAt =
      row.end_time
        ? toDate(
            row.end_time,
            "existingAppointment.end_time"
          )
        : new Date(
            startAt.getTime() +
              60 * 60 * 1000
          );

    stops.push({
      appointmentId:
        row.appointment_id,

      /*
       * locationId solo necesita ser único dentro de la simulación.
       * El provider no consulta la base de datos.
       */
      locationId:
        `appointment:${row.appointment_id}`,

      latitude,
      longitude,

      scheduledStartAt:
        startAt.toISOString(),

      scheduledEndAt:
        endAt.toISOString(),

      serviceDurationSeconds:
        calculateServiceDurationSeconds(
          startAt,
          endAt
        ),

      bufferAfterSeconds:
        input.bufferAfterSeconds,

      isLocked: true,

      metadata: {
        source:
          "existing_appointment",

        formattedAddress:
          row.formatted_address,

        scheduledStartAt:
          startAt.toISOString(),

        scheduledEndAt:
          endAt.toISOString(),

        hypothetical:
          false,
      },
    });
  }

  return stops;
}

function resolveRouteStartAt(input: {
  stops: RoutingStopInput[];
  startLocation: RoutingCoordinate | null;
  averageSpeedKph: number;
}): string | null {
  const firstStop =
    [...input.stops]
      .filter(
        (stop) =>
          Boolean(stop.scheduledStartAt)
      )
      .sort(
        (first, second) =>
          new Date(
            first.scheduledStartAt as string
          ).getTime() -
          new Date(
            second.scheduledStartAt as string
          ).getTime()
      )[0];

  if (!firstStop?.scheduledStartAt) {
    return null;
  }

  const firstStart =
    new Date(firstStop.scheduledStartAt);

  if (
    Number.isNaN(firstStart.getTime())
  ) {
    return null;
  }

  if (!input.startLocation) {
    /*
     * Si el recurso no tiene base configurada, la simulación
     * comienza en la primera cita. Las conexiones posteriores
     * siguen validándose normalmente.
     */
    return firstStart.toISOString();
  }

  const distanceToFirst =
    calculateHaversineDistanceMeters(
      input.startLocation,
      {
        latitude:
          firstStop.latitude,

        longitude:
          firstStop.longitude,
      }
    );

  const driveSecondsToFirst =
    estimateDriveSeconds({
      distanceMeters:
        distanceToFirst,

      averageSpeedKph:
        input.averageSpeedKph,
    });

  /*
   * La disponibilidad comercial ya determina a qué horas
   * puede trabajar el tenant.
   *
   * Aquí calculamos cuándo tendría que salir desde su base
   * para alcanzar la primera cita puntualmente.
   */
  return new Date(
    firstStart.getTime() -
      driveSecondsToFirst * 1000
  ).toISOString();
}

function findRouteViolations(input: {
  orderedStops: RoutingStopOutput[];
  hypotheticalAppointmentId: string;
}): RouteViolation[] {
  const violations: RouteViolation[] = [];

  for (const stop of input.orderedStops) {
    const scheduledStartAt =
      optionalString(
        stop.metadata?.scheduledStartAt
      );

    const physicalArrivalAt =
      optionalString(
        stop.metadata?.physicalArrivalAt
      );

    if (
      !scheduledStartAt ||
      !physicalArrivalAt
    ) {
      continue;
    }

    const scheduledTimestamp =
      new Date(
        scheduledStartAt
      ).getTime();

    const physicalTimestamp =
      new Date(
        physicalArrivalAt
      ).getTime();

    if (
      Number.isNaN(
        scheduledTimestamp
      ) ||
      Number.isNaN(
        physicalTimestamp
      )
    ) {
      continue;
    }

    const delaySeconds =
      Math.max(
        0,
        Math.ceil(
          (
            physicalTimestamp -
            scheduledTimestamp
          ) / 1000
        )
      );

    if (delaySeconds <= 0) {
      continue;
    }

    violations.push({
      appointmentId:
        stop.appointmentId ?? null,

      scheduledStartAt,
      physicalArrivalAt,

      delaySeconds,

      isHypotheticalAppointment:
        stop.appointmentId ===
        input.hypotheticalAppointmentId,
    });
  }

  return violations;
}

export async function checkRouteFeasibility(
  input: CheckRouteFeasibilityInput
): Promise<CheckRouteFeasibilityResult> {
  const tenantId =
    requiredString(
      input.tenantId,
      "tenantId"
    );

  const resourceId =
    requiredString(
      input.resourceId,
      "resourceId"
    );

  const startAt =
    toDate(
      input.startAt,
      "startAt"
    );

  const endAt =
    toDate(
      input.endAt,
      "endAt"
    );

  if (
    endAt.getTime() <=
    startAt.getTime()
  ) {
    throw new Error(
      "FIELD_OPERATIONS_INVALID_APPOINTMENT_RANGE"
    );
  }

  const latitude =
    parseCoordinate(
      input.latitude,
      -90,
      90
    );

  const longitude =
    parseCoordinate(
      input.longitude,
      -180,
      180
    );

  if (
    latitude === null ||
    longitude === null
  ) {
    return {
      feasible: false,
      resourceId,

      violations: [],
      orderedStops: [],

      totalDistanceMeters: 0,
      totalDriveSeconds: 0,

      reason:
        "INVALID_COORDINATES",
    };
  }

  const resource =
    await getFieldOperationResourceById({
      tenantId,
      resourceId,
    });

  if (!resource) {
    return {
      feasible: false,
      resourceId,

      violations: [],
      orderedStops: [],

      totalDistanceMeters: 0,
      totalDriveSeconds: 0,

      reason:
        "RESOURCE_NOT_FOUND",
    };
  }

  if (!resource.active) {
    return {
      feasible: false,
      resourceId,

      violations: [],
      orderedStops: [],

      totalDistanceMeters: 0,
      totalDriveSeconds: 0,

      reason:
        "RESOURCE_INACTIVE",
    };
  }

  const settings =
    await getAppointmentSettings(
      tenantId
    );

  const timezone =
    String(
      resource.timezone ??
      settings.timezone ??
      ""
    ).trim() ||
    "America/New_York";

  const serviceDate =
    serviceDateForTimezone(
      startAt,
      timezone
    );

  const bufferAfterSeconds =
    Math.max(
      0,
      Math.round(
        Number(
          settings.buffer_min ?? 0
        ) * 60
      )
    );

  const hypotheticalAppointmentId =
    optionalString(
      input.hypotheticalAppointmentId
    ) ||
    `hypothetical:${resourceId}:${startAt.toISOString()}`;

  const existingStops =
    await loadExistingStops({
      tenantId,
      resourceId,

      serviceDate,
      timezone,

      excludedAppointmentId:
        optionalString(
          input.excludedAppointmentId
        ),

      bufferAfterSeconds,
    });

  const hypotheticalStop:
    RoutingStopInput = {
      appointmentId:
        hypotheticalAppointmentId,

      locationId:
        `hypothetical-location:${hypotheticalAppointmentId}`,

      latitude,
      longitude,

      scheduledStartAt:
        startAt.toISOString(),

      scheduledEndAt:
        endAt.toISOString(),

      serviceDurationSeconds:
        calculateServiceDurationSeconds(
          startAt,
          endAt
        ),

      bufferAfterSeconds,

      isLocked: true,

      metadata: {
        source:
          "hypothetical_booking",

        hypothetical:
          true,

        formattedAddress:
          optionalString(
            input.formattedAddress
          ),

        scheduledStartAt:
          startAt.toISOString(),

        scheduledEndAt:
          endAt.toISOString(),
      },
    };

  const stops = [
    ...existingStops,
    hypotheticalStop,
  ];

  const startLocation =
    buildStartLocation({
      latitude:
        parseCoordinate(
          resource.startLatitude,
          -90,
          90
        ),

      longitude:
        parseCoordinate(
          resource.startLongitude,
          -180,
          180
        ),
    });

  const averageSpeedKph = 35;

  const routeStartAt =
    resolveRouteStartAt({
      stops,
      startLocation,
      averageSpeedKph,
    });

  const provider =
    new LocalApproximateRoutingProvider();

  const optimization =
    await provider.optimize({
      tenantId,
      resourceId,
      serviceDate,

      stops,

      startLocation,
      endLocation: null,

      routeStartAt,

      options: {
        preserveScheduledOrder:
          true,

        returnToStart:
          false,

        averageSpeedKph,
      },
    });

  const violations =
    findRouteViolations({
      orderedStops:
        optimization.orderedStops,

      hypotheticalAppointmentId,
    });

  const feasible =
    violations.length === 0;

  console.log(
    "[FIELD_OPERATIONS][ROUTE_FEASIBILITY_CHECKED]",
    {
      tenantId,
      resourceId,

      serviceDate,

      hypotheticalAppointmentId,

      requestedStartAt:
        startAt.toISOString(),

      requestedEndAt:
        endAt.toISOString(),

      existingStops:
        existingStops.length,

      feasible,

      violations:
        violations.map(
          (violation) => ({
            appointmentId:
              violation.appointmentId,

            delaySeconds:
              violation.delaySeconds,

            isHypotheticalAppointment:
              violation
                .isHypotheticalAppointment,
          })
        ),
    }
  );

  return {
    feasible,
    resourceId,

    violations,

    orderedStops:
      optimization.orderedStops,

    totalDistanceMeters:
      optimization.totalDistanceMeters,

    totalDriveSeconds:
      optimization.totalDriveSeconds,

    reason:
      feasible
        ? "ROUTE_FEASIBLE"
        : "ROUTE_WOULD_CAUSE_DELAY",
  };
}