//src/lib/appointments/getBookingFlow.ts
import pool from "../db";

export type BookingStep = {
  step_key: string;
  step_order: number;
  prompt: string;
  expected_type: string;
  required: boolean;
};

export async function getBookingFlow(tenantId: string) {
  const { rows } = await pool.query(
    `
    SELECT
      step_key,
      step_order,
      prompt,
      expected_type,
      required
    FROM appointment_booking_flows
    WHERE tenant_id = $1
      AND channel = 'voice'
      AND enabled = true
    ORDER BY step_order ASC
    `,
    [tenantId]
  );

  return rows as BookingStep[];
}