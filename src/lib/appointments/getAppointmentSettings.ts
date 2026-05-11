//src/lib/appointments/getAppointmentSettings.ts
import pool from "../db";

export type AppointmentSettings = {
  default_duration_min: number;
  buffer_min: number;
  min_lead_minutes: number;
  timezone: string;
  enabled: boolean;
};

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
      enabled
    FROM appointment_settings
    WHERE tenant_id = $1
    LIMIT 1
    `,
    [tenantId]
  );

  const row = rows[0];

  return {
    default_duration_min: Number(row?.default_duration_min ?? 60),
    buffer_min: Number(row?.buffer_min ?? 0),
    min_lead_minutes: Number(row?.min_lead_minutes ?? 0),
    timezone: String(row?.timezone || "America/New_York"),
    enabled: row?.enabled !== false,
  };
}