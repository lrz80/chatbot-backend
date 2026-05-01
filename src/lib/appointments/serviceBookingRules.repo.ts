//src/lib/appointments/serviceBookingRules.repo.ts
import pool from "../db";

export type BookingMode = "exclusive" | "shared";

export type AppointmentServiceRule = {
  id: string;
  tenant_id: string;
  service_name: string;
  duration_min: number;
  booking_mode: BookingMode;
  slot_capacity: number;
  created_at: string;
  updated_at: string;
};

export type UpsertAppointmentServiceRuleInput = {
  service_name: string;
  duration_min: number;
  booking_mode: BookingMode;
  slot_capacity: number;
};

function mapRow(row: any): AppointmentServiceRule {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    service_name: String(row.service_name),
    duration_min: Number(row.duration_min),
    booking_mode: row.booking_mode as BookingMode,
    slot_capacity: Number(row.slot_capacity),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

export async function getAppointmentServiceRules(
  tenantId: string
): Promise<AppointmentServiceRule[]> {
  const { rows } = await pool.query(
    `
    SELECT
      id,
      tenant_id,
      service_name,
      duration_min,
      booking_mode,
      slot_capacity,
      created_at,
      updated_at
    FROM appointment_service_rules
    WHERE tenant_id = $1
    ORDER BY lower(service_name) ASC
    `,
    [tenantId]
  );

  return rows.map(mapRow);
}

export async function replaceAppointmentServiceRules(params: {
  tenantId: string;
  rules: UpsertAppointmentServiceRuleInput[];
}): Promise<AppointmentServiceRule[]> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `
      DELETE FROM appointment_service_rules
      WHERE tenant_id = $1
      `,
      [params.tenantId]
    );

    for (const rule of params.rules) {
      await client.query(
        `
        INSERT INTO appointment_service_rules (
          tenant_id,
          service_name,
          duration_min,
          booking_mode,
          slot_capacity,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
        `,
        [
          params.tenantId,
          rule.service_name,
          rule.duration_min,
          rule.booking_mode,
          rule.slot_capacity,
        ]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return getAppointmentServiceRules(params.tenantId);
}