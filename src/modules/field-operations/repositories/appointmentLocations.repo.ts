// src/modules/field-operations/repositories/appointmentLocations.repo.ts

import { randomUUID } from "node:crypto";
import pool from "../../../lib/db";
import type {
  AppointmentLocation,
  AppointmentLocationType,
} from "../domain/fieldOperations.types";

type DatabaseJson = Record<string, unknown> | unknown[];

type AppointmentLocationRow = {
  id: string;
  tenant_id: string;
  appointment_id: string;

  location_type: AppointmentLocationType;

  formatted_address: string;
  address_components: DatabaseJson | null;

  latitude: number | string | null;
  longitude: number | string | null;

  geocoding_provider: string | null;
  provider_place_id: string | null;
  geocoding_status: string;
  geocoding_error: string | null;

  metadata: DatabaseJson | null;

  created_at: Date | string;
  updated_at: Date | string;
};

export type SaveAppointmentLocationInput = {
  tenantId: string;
  appointmentId: string;

  locationType?: AppointmentLocationType;

  formattedAddress: string;
  addressComponents?: Record<string, unknown>;

  latitude?: number | null;
  longitude?: number | null;

  geocodingProvider?: string | null;
  providerPlaceId?: string | null;
  geocodingStatus?: string;
  geocodingError?: string | null;

  metadata?: Record<string, unknown>;
};

function cleanRequiredString(value: unknown, fieldName: string): string {
  const result = String(value ?? "").trim();

  if (!result) {
    throw new Error(`FIELD_OPERATIONS_REQUIRED_FIELD:${fieldName}`);
  }

  return result;
}

function cleanOptionalString(value: unknown): string | null {
  const result = String(value ?? "").trim();
  return result || null;
}

function normalizeCoordinate(
  value: unknown,
  fieldName: string,
  minimum: number,
  maximum: number
): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numberValue = Number(value);

  if (
    !Number.isFinite(numberValue) ||
    numberValue < minimum ||
    numberValue > maximum
  ) {
    throw new Error(`FIELD_OPERATIONS_INVALID_COORDINATE:${fieldName}`);
  }

  return numberValue;
}

function parseNumberOrNull(value: number | string | null): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function parseObjectJson(value: DatabaseJson | null): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return {};
  }

  return value as Record<string, unknown>;
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

function mapAppointmentLocationRow(
  row: AppointmentLocationRow
): AppointmentLocation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    appointmentId: row.appointment_id,

    locationType: row.location_type,
    formattedAddress: row.formatted_address,
    addressComponents: parseObjectJson(row.address_components),

    latitude: parseNumberOrNull(row.latitude),
    longitude: parseNumberOrNull(row.longitude),

    geocodingProvider: row.geocoding_provider,
    providerPlaceId: row.provider_place_id,
    geocodingStatus: row.geocoding_status,
    geocodingError: row.geocoding_error,

    metadata: parseObjectJson(row.metadata),

    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

export async function saveAppointmentLocation(
  input: SaveAppointmentLocationInput
): Promise<AppointmentLocation> {
  const id = randomUUID();

  const tenantId = cleanRequiredString(input.tenantId, "tenantId");
  const appointmentId = cleanRequiredString(
    input.appointmentId,
    "appointmentId"
  );

  const locationType = input.locationType ?? "service";

  const formattedAddress = cleanRequiredString(
    input.formattedAddress,
    "formattedAddress"
  );

  const latitude = normalizeCoordinate(
    input.latitude,
    "latitude",
    -90,
    90
  );

  const longitude = normalizeCoordinate(
    input.longitude,
    "longitude",
    -180,
    180
  );

  const geocodingStatus =
    cleanOptionalString(input.geocodingStatus) ??
    (latitude !== null && longitude !== null ? "resolved" : "pending");

  const { rows } = await pool.query<AppointmentLocationRow>(
    `
    INSERT INTO appointment_locations (
      id,
      tenant_id,
      appointment_id,
      location_type,
      formatted_address,
      address_components,
      latitude,
      longitude,
      geocoding_provider,
      provider_place_id,
      geocoding_status,
      geocoding_error,
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
      $6::jsonb,
      $7,
      $8,
      $9,
      $10,
      $11,
      $12,
      $13::jsonb,
      NOW(),
      NOW()
    )
    ON CONFLICT (
      tenant_id,
      appointment_id,
      location_type
    )
    DO UPDATE SET
      formatted_address = EXCLUDED.formatted_address,
      address_components = EXCLUDED.address_components,
      latitude = EXCLUDED.latitude,
      longitude = EXCLUDED.longitude,
      geocoding_provider = EXCLUDED.geocoding_provider,
      provider_place_id = EXCLUDED.provider_place_id,
      geocoding_status = EXCLUDED.geocoding_status,
      geocoding_error = EXCLUDED.geocoding_error,
      metadata = EXCLUDED.metadata,
      updated_at = NOW()
    RETURNING *
    `,
    [
      id,
      tenantId,
      appointmentId,
      locationType,
      formattedAddress,
      JSON.stringify(input.addressComponents ?? {}),
      latitude,
      longitude,
      cleanOptionalString(input.geocodingProvider),
      cleanOptionalString(input.providerPlaceId),
      geocodingStatus,
      cleanOptionalString(input.geocodingError),
      JSON.stringify(input.metadata ?? {}),
    ]
  );

  const row = rows[0];

  if (!row) {
    throw new Error("FIELD_OPERATIONS_LOCATION_SAVE_FAILED");
  }

  return mapAppointmentLocationRow(row);
}

export async function getAppointmentLocation(input: {
  tenantId: string;
  appointmentId: string;
  locationType?: AppointmentLocationType;
}): Promise<AppointmentLocation | null> {
  const tenantId = cleanRequiredString(input.tenantId, "tenantId");
  const appointmentId = cleanRequiredString(
    input.appointmentId,
    "appointmentId"
  );

  const locationType = input.locationType ?? "service";

  const { rows } = await pool.query<AppointmentLocationRow>(
    `
    SELECT *
    FROM appointment_locations
    WHERE tenant_id = $1
      AND appointment_id = $2
      AND location_type = $3
    LIMIT 1
    `,
    [tenantId, appointmentId, locationType]
  );

  return rows[0] ? mapAppointmentLocationRow(rows[0]) : null;
}

export async function listAppointmentLocations(input: {
  tenantId: string;
  appointmentIds?: string[];
  geocodingStatus?: string;
}): Promise<AppointmentLocation[]> {
  const tenantId = cleanRequiredString(input.tenantId, "tenantId");

  const values: unknown[] = [tenantId];
  const conditions = ["tenant_id = $1"];

  const appointmentIds = Array.from(
    new Set(
      (input.appointmentIds ?? [])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    )
  );

  if (appointmentIds.length > 0) {
    values.push(appointmentIds);
    conditions.push(`appointment_id = ANY($${values.length}::text[])`);
  }

  const geocodingStatus = cleanOptionalString(input.geocodingStatus);

  if (geocodingStatus) {
    values.push(geocodingStatus);
    conditions.push(`geocoding_status = $${values.length}`);
  }

  const { rows } = await pool.query<AppointmentLocationRow>(
    `
    SELECT *
    FROM appointment_locations
    WHERE ${conditions.join("\n      AND ")}
    ORDER BY created_at ASC
    `,
    values
  );

  return rows.map(mapAppointmentLocationRow);
}

export async function updateAppointmentLocationGeocoding(input: {
  tenantId: string;
  appointmentId: string;
  locationType?: AppointmentLocationType;

  latitude: number | null;
  longitude: number | null;

  formattedAddress?: string;
  addressComponents?: Record<string, unknown>;

  geocodingProvider?: string | null;
  providerPlaceId?: string | null;

  geocodingStatus: string;
  geocodingError?: string | null;
}): Promise<AppointmentLocation | null> {
  const tenantId = cleanRequiredString(input.tenantId, "tenantId");
  const appointmentId = cleanRequiredString(
    input.appointmentId,
    "appointmentId"
  );

  const locationType = input.locationType ?? "service";

  const latitude = normalizeCoordinate(
    input.latitude,
    "latitude",
    -90,
    90
  );

  const longitude = normalizeCoordinate(
    input.longitude,
    "longitude",
    -180,
    180
  );

  const formattedAddress =
    input.formattedAddress === undefined
      ? null
      : cleanRequiredString(input.formattedAddress, "formattedAddress");

  const { rows } = await pool.query<AppointmentLocationRow>(
    `
    UPDATE appointment_locations
    SET
      formatted_address = COALESCE($4, formatted_address),
      address_components = COALESCE($5::jsonb, address_components),
      latitude = $6,
      longitude = $7,
      geocoding_provider = $8,
      provider_place_id = $9,
      geocoding_status = $10,
      geocoding_error = $11,
      updated_at = NOW()
    WHERE tenant_id = $1
      AND appointment_id = $2
      AND location_type = $3
    RETURNING *
    `,
    [
      tenantId,
      appointmentId,
      locationType,
      formattedAddress,
      input.addressComponents === undefined
        ? null
        : JSON.stringify(input.addressComponents),
      latitude,
      longitude,
      cleanOptionalString(input.geocodingProvider),
      cleanOptionalString(input.providerPlaceId),
      cleanRequiredString(input.geocodingStatus, "geocodingStatus"),
      cleanOptionalString(input.geocodingError),
    ]
  );

  return rows[0] ? mapAppointmentLocationRow(rows[0]) : null;
}

export async function deleteAppointmentLocation(input: {
  tenantId: string;
  appointmentId: string;
  locationType?: AppointmentLocationType;
}): Promise<boolean> {
  const tenantId = cleanRequiredString(input.tenantId, "tenantId");
  const appointmentId = cleanRequiredString(
    input.appointmentId,
    "appointmentId"
  );

  const locationType = input.locationType ?? "service";

  const result = await pool.query(
    `
    DELETE FROM appointment_locations
    WHERE tenant_id = $1
      AND appointment_id = $2
      AND location_type = $3
    `,
    [tenantId, appointmentId, locationType]
  );

  return (result.rowCount ?? 0) > 0;
}