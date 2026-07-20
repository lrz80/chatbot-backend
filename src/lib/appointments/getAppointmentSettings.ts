// src/lib/appointments/getAppointmentSettings.ts

import pool from "../db";

export type AppointmentSettings = {
  default_duration_min: number;
  buffer_min: number;
  min_lead_minutes: number;
  timezone: string;
  enabled: boolean;

  field_service_area_enabled: boolean;
  field_service_base_address: string | null;
  field_service_base_latitude: number | null;
  field_service_base_longitude: number | null;
  field_service_radius_miles: number | null;
};

function nullableNumber(
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

export async function getAppointmentSettings(
  tenantId: string
): Promise<AppointmentSettings> {
  const { rows } = await pool.query(
    `
    SELECT
      default_duration_min,
      buffer_min,
      min_lead_minutes,
      timezone,
      enabled,

      field_service_area_enabled,
      field_service_base_address,
      field_service_base_latitude,
      field_service_base_longitude,
      field_service_radius_miles

    FROM appointment_settings
    WHERE tenant_id = $1
    LIMIT 1
    `,
    [tenantId]
  );

  const row = rows[0];

  return {
    default_duration_min:
      Number(row?.default_duration_min ?? 60),

    buffer_min:
      Number(row?.buffer_min ?? 0),

    min_lead_minutes:
      Number(row?.min_lead_minutes ?? 0),

    timezone:
      String(
        row?.timezone ||
          "America/New_York"
      ),

    enabled:
      row?.enabled !== false,

    field_service_area_enabled:
      row?.field_service_area_enabled === true,

    field_service_base_address:
      String(
        row?.field_service_base_address ?? ""
      ).trim() || null,

    field_service_base_latitude:
      nullableNumber(
        row?.field_service_base_latitude
      ),

    field_service_base_longitude:
      nullableNumber(
        row?.field_service_base_longitude
      ),

    field_service_radius_miles:
      nullableNumber(
        row?.field_service_radius_miles
      ),
  };
}