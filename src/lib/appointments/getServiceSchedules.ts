//src/lib/appointments/getServiceSchedules.ts
import pool from "../db";

export type ServiceScheduleRow = {
  id: string;
  tenant_id: string;
  service_name: string;
  day_of_week: number;
  start_time: string;
  enabled: boolean;
  channel: string;
  created_at: string;
  updated_at: string;
};

type GetServiceSchedulesParams = {
  tenantId: string;
  channel?: string;
};

export async function getServiceSchedules(
  params: GetServiceSchedulesParams
): Promise<ServiceScheduleRow[]> {
  const channel = (params.channel || "voice").trim();

  const { rows } = await pool.query(
    `
    SELECT
      id,
      tenant_id,
      service_name,
      day_of_week,
      start_time,
      enabled,
      channel,
      created_at,
      updated_at
    FROM appointment_service_schedules
    WHERE tenant_id = $1
      AND channel = $2
    ORDER BY
      service_name ASC,
      day_of_week ASC,
      start_time ASC
    `,
    [params.tenantId, channel]
  );

  return rows as ServiceScheduleRow[];
}