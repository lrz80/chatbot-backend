// src/lib/voice/booking/services/resolveBookingServiceProvider.ts

import { resolveTenantBookingProvider } from "../../../appointments/booking/providers/resolveTenantBookingProvider";
import type { BookingProvider } from "../../../appointments/booking/providers/types";

export type BookingServiceProvider = "square" | "dashboard";

export async function resolveBookingServiceProvider(
  tenantId: string
): Promise<BookingServiceProvider> {
  const provider: BookingProvider | null = await resolveTenantBookingProvider(
    tenantId
  );

  if (provider === "square") {
    return "square";
  }

  return "dashboard";
}