//src/lib/appointments/serviceBookingRules.ts
import pool from "../db";
import { resolveAppointmentServiceId } from "./resolveAppointmentServiceId";

export async function countConfirmedAppointmentsForSlot(params: {
  tenantId: string;
  serviceName: string;
  startISO: string;
}): Promise<number> {
  const serviceId = await resolveAppointmentServiceId({
    tenantId: params.tenantId,
    serviceName: params.serviceName,
  });

  if (!serviceId) {
    return 0;
  }

  const { rows } = await pool.query(
    `
    SELECT COUNT(*)::int AS total
    FROM appointments
    WHERE tenant_id = $1
      AND status = 'confirmed'
      AND start_time = $2
      AND service_id = $3
    `,
    [params.tenantId, params.startISO, serviceId]
  );

  return Number(rows[0]?.total || 0);
}