//src/lib/appointments/booking/providers/resolveTenantBookingProvider.ts
import pool from "../../../../lib/db";
import type { BookingProvider } from "./types";

export async function resolveTenantBookingProvider(
  tenantId: string
): Promise<BookingProvider> {
  const { rows } = await pool.query(
    `
      SELECT booking_provider
      FROM tenants
      WHERE id = $1
      LIMIT 1
    `,
    [tenantId]
  );

  const raw = String(rows[0]?.booking_provider || "").trim();

  if (
    raw === "google_calendar" ||
    raw === "square" ||
    raw === "glofox" ||
    raw === "booksy"
  ) {
    return raw;
  }

  return "google_calendar";
}