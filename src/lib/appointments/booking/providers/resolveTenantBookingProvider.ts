import type { Pool } from "pg";
import type { BookingProvider } from "./types";

type Args = {
  pool: Pool;
  tenantId: string;
};

export async function resolveTenantBookingProvider(
  args: Args
): Promise<BookingProvider> {
  const { pool, tenantId } = args;

  const result = await pool.query(
    `
      SELECT booking_provider
      FROM tenants
      WHERE id = $1
      LIMIT 1
    `,
    [tenantId]
  );

  const value = result.rows[0]?.booking_provider;

  if (
    value === "google_calendar" ||
    value === "square" ||
    value === "glofox" ||
    value === "booksy"
  ) {
    return value;
  }

  return "google_calendar";
}