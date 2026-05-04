//src/lib/appointments/getBookingFlow.ts
import pool from "../db";

export type BookingStep = {
  step_key: string;
  step_order: number;
  prompt: string;
  expected_type: string;
  required: boolean;
  enabled: boolean;
  retry_prompt: string | null;
  validation_config: Record<string, unknown> | null;
};

type BookingFlowCacheEntry = {
  expiresAt: number;
  steps: BookingStep[];
};

const BOOKING_FLOW_TTL_MS = 30_000;
const bookingFlowCache = new Map<string, BookingFlowCacheEntry>();

function buildBookingFlowCacheKey(tenantId: string, channel: string) {
  return `${tenantId}:${channel}`;
}

export function clearBookingFlowCache(tenantId?: string, channel = "voice") {
  if (!tenantId) {
    bookingFlowCache.clear();
    return;
  }

  bookingFlowCache.delete(buildBookingFlowCacheKey(tenantId, channel));
}

export async function getBookingFlow(
  tenantId: string,
  channel = "voice"
): Promise<BookingStep[]> {
  const cacheKey = buildBookingFlowCacheKey(tenantId, channel);
  const now = Date.now();
  const cached = bookingFlowCache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return cached.steps;
  }

  const { rows } = await pool.query(
    `
    SELECT
      step_key,
      step_order,
      prompt,
      expected_type,
      required,
      enabled,
      retry_prompt,
      validation_config
    FROM appointment_booking_flows
    WHERE tenant_id = $1
      AND channel = $2
    ORDER BY step_order ASC
    `,
    [tenantId, channel]
  );

  const steps = rows as BookingStep[];

  bookingFlowCache.set(cacheKey, {
    expiresAt: now + BOOKING_FLOW_TTL_MS,
    steps,
  });

  return steps;
}