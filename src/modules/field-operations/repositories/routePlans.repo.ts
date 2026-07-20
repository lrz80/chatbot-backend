// src/modules/field-operations/repositories/routePlans.repo.ts

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import pool from "../../../lib/db";
import type {
  RouteOptimizationResult,
  RoutePlan,
  RoutePlanMode,
  RoutePlanStatus,
  RouteStopResult,
} from "../domain/fieldOperations.types";

type Queryable = Pick<PoolClient, "query">;

type RoutePlanRow = {
  id: string;
  tenant_id: string;
  resource_id: string;
  service_date: Date | string;
  status: RoutePlanStatus;
  mode: RoutePlanMode;
  routing_provider: string | null;
  total_distance_meters: number | string;
  total_drive_seconds: number | string;
  total_service_seconds: number | string;
  optimization_request: Record<string, unknown> | null;
  optimization_result: Record<string, unknown> | null;
  provider_metadata: Record<string, unknown> | null;
  calculation_started_at: Date | string | null;
  calculation_finished_at: Date | string | null;
  error_code: string | null;
  error_details: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export type RoutePlanStop = {
  id: string;
  tenantId: string;
  routePlanId: string;
  appointmentId: string | null;
  locationId: string;
  stopType: string;
  stopOrder: number;
  plannedArrivalAt: string | null;
  plannedDepartureAt: string | null;
  serviceDurationSeconds: number;
  driveSecondsFromPrevious: number;
  distanceMetersFromPrevious: number;
  isLocked: boolean;
  providerMetadata: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type RoutePlanStopRow = {
  id: string;
  tenant_id: string;
  route_plan_id: string;
  appointment_id: string | null;
  location_id: string;
  stop_type: string;
  stop_order: number;
  planned_arrival_at: Date | string | null;
  planned_departure_at: Date | string | null;
  service_duration_seconds: number;
  drive_seconds_from_previous: number;
  distance_meters_from_previous: number | string;
  is_locked: boolean;
  provider_metadata: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export type SaveRoutePlanInput = {
  tenantId: string;
  resourceId: string;
  serviceDate: string;
  mode?: RoutePlanMode;
  status?: RoutePlanStatus;
  optimizationRequest?: Record<string, unknown>;
};

export type SaveRoutePlanResultInput = {
  tenantId: string;
  routePlanId: string;
  result: RouteOptimizationResult;
  status?: RoutePlanStatus;
};

function requiredString(value: unknown, fieldName: string): string {
  const result = String(value ?? "").trim();

  if (!result) {
    throw new Error(`FIELD_OPERATIONS_REQUIRED_FIELD:${fieldName}`);
  }

  return result;
}

function parseNonNegativeInteger(
  value: unknown,
  fieldName: string
): number {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      `FIELD_OPERATIONS_INVALID_NON_NEGATIVE_INTEGER:${fieldName}`
    );
  }

  return parsed;
}

function parseObject(
  value: Record<string, unknown> | null
): Record<string, unknown> {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? value
    : {};
}

function toIsoString(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error("FIELD_OPERATIONS_INVALID_DATABASE_TIMESTAMP");
  }

  return parsed.toISOString();
}

function toNullableIsoString(
  value: Date | string | null
): string | null {
  return value === null ? null : toIsoString(value);
}

function normalizeServiceDate(value: unknown): string {
  const result = requiredString(value, "serviceDate");

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(result);

  if (!match) {
    throw new Error("FIELD_OPERATIONS_INVALID_SERVICE_DATE");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error("FIELD_OPERATIONS_INVALID_SERVICE_DATE");
  }

  return result;
}

function databaseDateToString(value: Date | string): string {
  if (typeof value === "string") {
    return value.slice(0, 10);
  }

  return [
    value.getUTCFullYear(),
    String(value.getUTCMonth() + 1).padStart(2, "0"),
    String(value.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function mapRoutePlanRow(row: RoutePlanRow): RoutePlan {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    resourceId: row.resource_id,
    serviceDate: databaseDateToString(row.service_date),
    status: row.status,
    mode: row.mode,
    routingProvider: row.routing_provider,
    totalDistanceMeters: Number(row.total_distance_meters),
    totalDriveSeconds: Number(row.total_drive_seconds),
    totalServiceSeconds: Number(row.total_service_seconds),
    optimizationRequest: parseObject(row.optimization_request),
    optimizationResult: parseObject(row.optimization_result),
    providerMetadata: parseObject(row.provider_metadata),
    calculationStartedAt: toNullableIsoString(
      row.calculation_started_at
    ),
    calculationFinishedAt: toNullableIsoString(
      row.calculation_finished_at
    ),
    errorCode: row.error_code,
    errorDetails: parseObject(row.error_details),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapRoutePlanStopRow(
  row: RoutePlanStopRow
): RoutePlanStop {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    routePlanId: row.route_plan_id,
    appointmentId: row.appointment_id,
    locationId: row.location_id,
    stopType: row.stop_type,
    stopOrder: row.stop_order,
    plannedArrivalAt: toNullableIsoString(row.planned_arrival_at),
    plannedDepartureAt: toNullableIsoString(
      row.planned_departure_at
    ),
    serviceDurationSeconds: row.service_duration_seconds,
    driveSecondsFromPrevious: row.drive_seconds_from_previous,
    distanceMetersFromPrevious: Number(
      row.distance_meters_from_previous
    ),
    isLocked: row.is_locked,
    providerMetadata: parseObject(row.provider_metadata),
    metadata: parseObject(row.metadata),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

async function getRoutePlanByIdWithClient(
  client: Queryable,
  input: {
    tenantId: string;
    routePlanId: string;
  }
): Promise<RoutePlan | null> {
  const { rows } = await client.query<RoutePlanRow>(
    `
    SELECT *
    FROM route_plans
    WHERE tenant_id = $1
      AND id = $2
    LIMIT 1
    `,
    [input.tenantId, input.routePlanId]
  );

  return rows[0] ? mapRoutePlanRow(rows[0]) : null;
}

async function insertRoutePlanStops(
  client: Queryable,
  input: {
    tenantId: string;
    routePlanId: string;
    stops: RouteStopResult[];
  }
): Promise<void> {
  for (const stop of input.stops) {
    const stopOrder = parseNonNegativeInteger(
      stop.order,
      "stop.order"
    );

    const driveSecondsFromPrevious = parseNonNegativeInteger(
      stop.driveSecondsFromPrevious,
      "stop.driveSecondsFromPrevious"
    );

    const distanceMetersFromPrevious = parseNonNegativeInteger(
      stop.distanceMetersFromPrevious,
      "stop.distanceMetersFromPrevious"
    );

    const serviceDurationSeconds = parseNonNegativeInteger(
      stop.serviceDurationSeconds,
      "stop.serviceDurationSeconds"
    );

    await client.query(
      `
      INSERT INTO route_plan_stops (
        id,
        tenant_id,
        route_plan_id,
        appointment_id,
        location_id,
        stop_type,
        stop_order,
        planned_arrival_at,
        planned_departure_at,
        service_duration_seconds,
        drive_seconds_from_previous,
        distance_meters_from_previous,
        is_locked,
        provider_metadata,
        metadata,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        'service',
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        FALSE,
        '{}'::jsonb,
        $12::jsonb,
        NOW(),
        NOW()
      )
      `,
      [
        randomUUID(),
        input.tenantId,
        input.routePlanId,
        stop.appointmentId,
        requiredString(stop.locationId, "stop.locationId"),
        stopOrder,
        stop.plannedArrivalAt,
        stop.plannedDepartureAt,
        serviceDurationSeconds,
        driveSecondsFromPrevious,
        distanceMetersFromPrevious,
        JSON.stringify(stop.metadata ?? {}),
      ]
    );
  }
}

export async function saveRoutePlan(
  input: SaveRoutePlanInput
): Promise<RoutePlan> {
  const id = randomUUID();

  const tenantId = requiredString(input.tenantId, "tenantId");
  const resourceId = requiredString(input.resourceId, "resourceId");
  const serviceDate = normalizeServiceDate(input.serviceDate);

  const mode = input.mode ?? "view_only";
  const status = input.status ?? "draft";

  const { rows } = await pool.query<RoutePlanRow>(
    `
    INSERT INTO route_plans (
      id,
      tenant_id,
      resource_id,
      service_date,
      status,
      mode,
      optimization_request,
      created_at,
      updated_at
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7::jsonb,
      NOW(),
      NOW()
    )
    ON CONFLICT (
      tenant_id,
      resource_id,
      service_date
    )
    DO UPDATE SET
      status = EXCLUDED.status,
      mode = EXCLUDED.mode,
      optimization_request = EXCLUDED.optimization_request,
      routing_provider = NULL,
      total_distance_meters = 0,
      total_drive_seconds = 0,
      total_service_seconds = 0,
      optimization_result = '{}'::jsonb,
      provider_metadata = '{}'::jsonb,
      calculation_started_at = NULL,
      calculation_finished_at = NULL,
      error_code = NULL,
      error_details = '{}'::jsonb,
      updated_at = NOW()
    RETURNING *
    `,
    [
      id,
      tenantId,
      resourceId,
      serviceDate,
      status,
      mode,
      JSON.stringify(input.optimizationRequest ?? {}),
    ]
  );

  const row = rows[0];

  if (!row) {
    throw new Error("FIELD_OPERATIONS_ROUTE_PLAN_SAVE_FAILED");
  }

  return mapRoutePlanRow(row);
}

export async function getRoutePlanById(input: {
  tenantId: string;
  routePlanId: string;
}): Promise<RoutePlan | null> {
  return getRoutePlanByIdWithClient(pool, {
    tenantId: requiredString(input.tenantId, "tenantId"),
    routePlanId: requiredString(input.routePlanId, "routePlanId"),
  });
}

export async function getRoutePlanByResourceAndDate(input: {
  tenantId: string;
  resourceId: string;
  serviceDate: string;
}): Promise<RoutePlan | null> {
  const tenantId = requiredString(input.tenantId, "tenantId");
  const resourceId = requiredString(input.resourceId, "resourceId");
  const serviceDate = normalizeServiceDate(input.serviceDate);

  const { rows } = await pool.query<RoutePlanRow>(
    `
    SELECT *
    FROM route_plans
    WHERE tenant_id = $1
      AND resource_id = $2
      AND service_date = $3
    LIMIT 1
    `,
    [tenantId, resourceId, serviceDate]
  );

  return rows[0] ? mapRoutePlanRow(rows[0]) : null;
}

export async function listRoutePlans(input: {
  tenantId: string;
  serviceDate?: string;
  resourceId?: string;
  status?: RoutePlanStatus;
}): Promise<RoutePlan[]> {
  const tenantId = requiredString(input.tenantId, "tenantId");

  const values: unknown[] = [tenantId];
  const conditions = ["tenant_id = $1"];

  if (input.serviceDate !== undefined) {
    values.push(normalizeServiceDate(input.serviceDate));
    conditions.push(`service_date = $${values.length}`);
  }

  if (input.resourceId !== undefined) {
    values.push(requiredString(input.resourceId, "resourceId"));
    conditions.push(`resource_id = $${values.length}`);
  }

  if (input.status !== undefined) {
    values.push(input.status);
    conditions.push(`status = $${values.length}`);
  }

  const { rows } = await pool.query<RoutePlanRow>(
    `
    SELECT *
    FROM route_plans
    WHERE ${conditions.join("\n      AND ")}
    ORDER BY service_date ASC, created_at ASC
    `,
    values
  );

  return rows.map(mapRoutePlanRow);
}

export async function listRoutePlanStops(input: {
  tenantId: string;
  routePlanId: string;
}): Promise<RoutePlanStop[]> {
  const tenantId = requiredString(input.tenantId, "tenantId");
  const routePlanId = requiredString(
    input.routePlanId,
    "routePlanId"
  );

  const { rows } = await pool.query<RoutePlanStopRow>(
    `
    SELECT *
    FROM route_plan_stops
    WHERE tenant_id = $1
      AND route_plan_id = $2
    ORDER BY stop_order ASC
    `,
    [tenantId, routePlanId]
  );

  return rows.map(mapRoutePlanStopRow);
}

export async function markRoutePlanCalculating(input: {
  tenantId: string;
  routePlanId: string;
}): Promise<RoutePlan | null> {
  const tenantId = requiredString(input.tenantId, "tenantId");
  const routePlanId = requiredString(
    input.routePlanId,
    "routePlanId"
  );

  const { rows } = await pool.query<RoutePlanRow>(
    `
    UPDATE route_plans
    SET status = 'calculating',
        calculation_started_at = NOW(),
        calculation_finished_at = NULL,
        error_code = NULL,
        error_details = '{}'::jsonb,
        updated_at = NOW()
    WHERE tenant_id = $1
      AND id = $2
    RETURNING *
    `,
    [tenantId, routePlanId]
  );

  return rows[0] ? mapRoutePlanRow(rows[0]) : null;
}

export async function saveRoutePlanResult(
  input: SaveRoutePlanResultInput
): Promise<RoutePlan> {
  const tenantId = requiredString(input.tenantId, "tenantId");
  const routePlanId = requiredString(
    input.routePlanId,
    "routePlanId"
  );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existing = await getRoutePlanByIdWithClient(client, {
      tenantId,
      routePlanId,
    });

    if (!existing) {
      throw new Error("FIELD_OPERATIONS_ROUTE_PLAN_NOT_FOUND");
    }

    await client.query(
      `
      DELETE FROM route_plan_stops
      WHERE tenant_id = $1
        AND route_plan_id = $2
      `,
      [tenantId, routePlanId]
    );

    await insertRoutePlanStops(client, {
      tenantId,
      routePlanId,
      stops: input.result.orderedStops,
    });

    const totalDistanceMeters = parseNonNegativeInteger(
      input.result.totalDistanceMeters,
      "totalDistanceMeters"
    );

    const totalDriveSeconds = parseNonNegativeInteger(
      input.result.totalDriveSeconds,
      "totalDriveSeconds"
    );

    const totalServiceSeconds = parseNonNegativeInteger(
      input.result.totalServiceSeconds,
      "totalServiceSeconds"
    );

    const { rows } = await client.query<RoutePlanRow>(
      `
      UPDATE route_plans
      SET status = $3,
          routing_provider = $4,
          total_distance_meters = $5,
          total_drive_seconds = $6,
          total_service_seconds = $7,
          optimization_result = $8::jsonb,
          provider_metadata = $9::jsonb,
          calculation_finished_at = NOW(),
          error_code = NULL,
          error_details = '{}'::jsonb,
          updated_at = NOW()
      WHERE tenant_id = $1
        AND id = $2
      RETURNING *
      `,
      [
        tenantId,
        routePlanId,
        input.status ?? "ready",
        requiredString(input.result.provider, "provider"),
        totalDistanceMeters,
        totalDriveSeconds,
        totalServiceSeconds,
        JSON.stringify(input.result),
        JSON.stringify(input.result.providerMetadata ?? {}),
      ]
    );

    const row = rows[0];

    if (!row) {
      throw new Error("FIELD_OPERATIONS_ROUTE_PLAN_UPDATE_FAILED");
    }

    await client.query("COMMIT");

    return mapRoutePlanRow(row);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markRoutePlanFailed(input: {
  tenantId: string;
  routePlanId: string;
  errorCode: string;
  errorDetails?: Record<string, unknown>;
}): Promise<RoutePlan | null> {
  const tenantId = requiredString(input.tenantId, "tenantId");
  const routePlanId = requiredString(
    input.routePlanId,
    "routePlanId"
  );
  const errorCode = requiredString(input.errorCode, "errorCode");

  const { rows } = await pool.query<RoutePlanRow>(
    `
    UPDATE route_plans
    SET status = 'failed',
        calculation_finished_at = NOW(),
        error_code = $3,
        error_details = $4::jsonb,
        updated_at = NOW()
    WHERE tenant_id = $1
      AND id = $2
    RETURNING *
    `,
    [
      tenantId,
      routePlanId,
      errorCode,
      JSON.stringify(input.errorDetails ?? {}),
    ]
  );

  return rows[0] ? mapRoutePlanRow(rows[0]) : null;
}