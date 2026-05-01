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

    console.log("[BOOKING][PROVIDER_RESOLUTION]", {
      tenantId,
      provider,
      found: Boolean(connection),
      status: connection?.status ?? null,
    });

    if (connection && connection.status === "active") {
      return provider;
    }
  }

  console.warn("[BOOKING][PROVIDER_NOT_RESOLVED]", {
    tenantId,
    checkedProviders: SUPPORTED_ACTIVE_PROVIDERS,
  });

  return null;
}