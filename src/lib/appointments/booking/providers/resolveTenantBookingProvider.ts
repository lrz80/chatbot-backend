//src/lib/appointments/booking/providers/resolveTenantBookingProvider.ts
import pool from "../../../../lib/db";
import { getBookingProviderConnection } from "./providerConnections.repo";
import type { BookingProvider } from "./types";

function isValidBookingProvider(value: string): value is BookingProvider {
  return (
    value === "google_calendar" ||
    value === "square" ||
    value === "glofox" ||
    value === "booksy"
  );
}

export async function resolveTenantBookingProvider(
  tenantId: string
): Promise<BookingProvider> {
  const candidateProviders: BookingProvider[] = [
    "square",
    "google_calendar",
    "glofox",
    "booksy",
  ];

  for (const provider of candidateProviders) {
    const connection = await getBookingProviderConnection(tenantId, provider);

    if (connection && connection.status === "active") {
      return provider;
    }
  }

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

  if (isValidBookingProvider(raw)) {
    return raw;
  }

  return "google_calendar";
}