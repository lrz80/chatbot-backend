//src/lib/appointments/serviceBookingRules.ts
import pool from "../db";
import { resolveAppointmentServiceId } from "./resolveAppointmentServiceId";

export type BookingMode = "exclusive" | "shared";

export type EffectiveServiceBookingRule = {
  service_id: string | null;
  service_name: string;
  duration_min: number;
  booking_mode: BookingMode;
  slot_capacity: number;
};

export async function getEffectiveServiceBookingRule(params: {
  tenantId: string;
  serviceName: string;
}): Promise<EffectiveServiceBookingRule> {
  const serviceName = String(params.serviceName || "").trim();

  const settingsRes = await pool.query(
    `
    SELECT default_duration_min
    FROM appointment_settings
    WHERE tenant_id = $1
    LIMIT 1
    `,
    [params.tenantId]
  );

  const defaultDurationMin = Number(
    settingsRes.rows[0]?.default_duration_min || 45
  );

  const serviceId = await resolveAppointmentServiceId({
    tenantId: params.tenantId,
    serviceName,
  });

  const ruleRes = await pool.query(
    `
    SELECT
      service_name,
      duration_min,
      booking_mode,
      slot_capacity
    FROM appointment_service_rules
    WHERE tenant_id = $1
      AND lower(service_name) = lower($2)
    LIMIT 1
    `,
    [params.tenantId, serviceName]
  );

  const row = ruleRes.rows[0];

  if (!row) {
    return {
      service_id: serviceId,
      service_name: serviceName,
      duration_min: defaultDurationMin,
      booking_mode: "exclusive",
      slot_capacity: 1,
    };
  }

  return {
    service_id: serviceId,
    service_name: String(row.service_name),
    duration_min: Number(row.duration_min || defaultDurationMin),
    booking_mode: row.booking_mode === "shared" ? "shared" : "exclusive",
    slot_capacity: Number(row.slot_capacity || 1),
  };
}

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