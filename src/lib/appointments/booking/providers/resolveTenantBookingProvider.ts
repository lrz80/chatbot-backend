//src/lib/appointments/booking/providers/resolveTenantBookingProvider.ts
import { getBookingProviderConnection } from "./providerConnections.repo";
import type { BookingProvider } from "./types";

const SUPPORTED_ACTIVE_PROVIDERS: BookingProvider[] = [
  "square",
  "google_calendar",
];

type ProviderCacheEntry = {
  value: BookingProvider | null;
  expiresAt: number;
};

const BOOKING_PROVIDER_CACHE_TTL_MS = 60_000;
const bookingProviderCache = new Map<string, ProviderCacheEntry>();

export function clearTenantBookingProviderCache(tenantId?: string) {
  if (!tenantId) {
    bookingProviderCache.clear();
    return;
  }

  bookingProviderCache.delete(tenantId);
}

export async function resolveTenantBookingProvider(
  tenantId: string
): Promise<BookingProvider | null> {
  const now = Date.now();
  const cached = bookingProviderCache.get(tenantId);

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  for (const provider of SUPPORTED_ACTIVE_PROVIDERS) {
    const connection = await getBookingProviderConnection(tenantId, provider);

    console.log("[BOOKING][PROVIDER_RESOLUTION]", {
      tenantId,
      provider,
      found: Boolean(connection),
      status: connection?.status ?? null,
      cached: false,
    });

    if (connection && connection.status === "active") {
      bookingProviderCache.set(tenantId, {
        value: provider,
        expiresAt: now + BOOKING_PROVIDER_CACHE_TTL_MS,
      });

      return provider;
    }
  }

  console.warn("[BOOKING][PROVIDER_NOT_RESOLVED]", {
    tenantId,
    checkedProviders: SUPPORTED_ACTIVE_PROVIDERS,
  });

  bookingProviderCache.set(tenantId, {
    value: null,
    expiresAt: now + BOOKING_PROVIDER_CACHE_TTL_MS,
  });

  return null;
}