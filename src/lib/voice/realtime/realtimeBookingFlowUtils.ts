// src/lib/voice/realtime/realtimeBookingFlowUtils.ts

/**
 * Backward-compatible re-export.
 *
 * The booking flow runtime is channel-agnostic and now lives under
 * appointments/booking/runtime.
 *
 * Voice files may continue importing from this path while the migration
 * is completed, without duplicating booking logic.
 */
export * from "../../appointments/booking/runtime/bookingFlowRuntimeUtils";