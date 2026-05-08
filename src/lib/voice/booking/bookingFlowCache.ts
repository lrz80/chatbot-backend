//src/lib/voice/booking/bookingFlowCache.ts
import { getBookingFlow } from "../../appointments/getBookingFlow";

type CachedBookingFlow = Awaited<ReturnType<typeof getBookingFlow>>;

type BookingFlowCacheEntry = {
  expiresAt: number;
  flow: CachedBookingFlow;
};

const BOOKING_FLOW_TTL_MS = 60_000;
const bookingFlowCache = new Map<string, BookingFlowCacheEntry>();

export function clearVoiceBookingFlowCache(tenantId?: string) {
  if (!tenantId) {
    bookingFlowCache.clear();
    return;
  }

  bookingFlowCache.delete(tenantId);
}

export async function getCachedBookingFlow(
  tenantId: string
): Promise<CachedBookingFlow> {
  const now = Date.now();
  const cached = bookingFlowCache.get(tenantId);

  if (cached && cached.expiresAt > now) {
    return cached.flow;
  }

  const flow = await getBookingFlow(tenantId);

  bookingFlowCache.set(tenantId, {
    expiresAt: now + BOOKING_FLOW_TTL_MS,
    flow,
  });

  return flow;
}