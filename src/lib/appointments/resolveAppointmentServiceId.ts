//src/lib/appointments/resolveAppointmentServiceId.ts
import pool from "../db";

export async function resolveAppointmentServiceId(params: {
  tenantId: string;
  serviceName: string;
}): Promise<string | null> {
  const serviceName = String(params.serviceName || "").trim();

  if (!serviceName) {
    return null;
  }

  const { rows } = await pool.query(
    `
    SELECT id
    FROM services
    WHERE tenant_id = $1
      AND lower(name) = lower($2)
    LIMIT 1
    `,
    [params.tenantId, serviceName]
  );

  return rows[0]?.id ? String(rows[0].id) : null;
}