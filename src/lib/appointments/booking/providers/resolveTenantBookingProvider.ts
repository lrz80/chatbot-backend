//src/lib/appointments/booking/providers/resolveTenantBookingProvider.ts
import { getBookingProviderConnection } from "./providerConnections.repo";
import type { BookingProvider } from "./types";

const SUPPORTED_ACTIVE_PROVIDERS: BookingProvider[] = [
  "square",
  "google_calendar",
];

export async function resolveTenantBookingProvider(
  tenantId: string
): Promise<BookingProvider | null> {
  for (const provider of SUPPORTED_ACTIVE_PROVIDERS) {
    const connection = await getBookingProviderConnection(tenantId, provider);

    if (connection && connection.status === "active") {
      return provider;
    }
  }

  return null;
}