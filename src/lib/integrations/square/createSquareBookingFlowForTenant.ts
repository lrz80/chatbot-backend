// src/lib/integrations/square/createSquareBookingFlowForTenant.ts
import { getOrCreateSquareCustomerForTenant } from "./getOrCreateSquareCustomerForTenant";
import { searchSquareAvailabilityForTenant } from "./searchSquareAvailabilityForTenant";
import { createSquareBookingForTenant } from "./createSquareBookingForTenant";
import type { SquareBooking } from "./createSquareBooking";
import type { SquareAvailability } from "./searchSquareAvailability";

export type CreateSquareBookingFlowForTenantArgs = {
  tenantId: string;
  serviceVariationId: string;
  startAt: string;
  endAt: string;
  locationId?: string | null;

  customer: {
    givenName?: string;
    familyName?: string;
    email?: string;
    phoneNumber?: string;
  };
};

export type CreateSquareBookingFlowForTenantResult =
  | {
      ok: true;
      customerId: string;
      availability: SquareAvailability;
      booking: SquareBooking;
    }
  | {
      ok: false;
      error: string;
      details?: unknown;
      status?: number;
      stage?: "customer" | "availability" | "booking";
    };

export async function createSquareBookingFlowForTenant(
  args: CreateSquareBookingFlowForTenantArgs
): Promise<CreateSquareBookingFlowForTenantResult> {
  const tenantId = String(args.tenantId || "").trim();
  const serviceVariationId = String(args.serviceVariationId || "").trim();
  const startAt = String(args.startAt || "").trim();
  const endAt = String(args.endAt || "").trim();
  const locationId = String(args.locationId || "").trim() || null;

  if (!tenantId || !serviceVariationId || !startAt || !endAt) {
    return {
      ok: false,
      error: "MISSING_REQUIRED_FIELDS",
      status: 400,
    };
  }

  const customerResult = await getOrCreateSquareCustomerForTenant({
    tenantId,
    givenName: args.customer.givenName,
    familyName: args.customer.familyName,
    email: args.customer.email,
    phoneNumber: args.customer.phoneNumber,
    });

  if (!customerResult.ok) {
    return {
      ...customerResult,
      stage: "customer",
    };
  }

  const availabilityResult = await searchSquareAvailabilityForTenant({
    tenantId,
    locationId,
    serviceVariationId,
    startAt,
    endAt,
  });

  if (!availabilityResult.ok) {
    return {
      ...availabilityResult,
      stage: "availability",
    };
  }

  const firstAvailability = availabilityResult.firstAvailability;

  if (!firstAvailability) {
    return {
      ok: false,
      error: "SQUARE_NO_AVAILABILITY_FOUND",
      status: 404,
      stage: "availability",
    };
  }

  const firstSegment = firstAvailability.appointment_segments?.[0];

  if (
    !firstSegment ||
    !firstSegment.team_member_id ||
    !firstSegment.service_variation_id ||
    !Number.isFinite(firstSegment.service_variation_version) ||
    !Number.isFinite(firstSegment.duration_minutes)
  ) {
    return {
      ok: false,
      error: "SQUARE_INVALID_AVAILABILITY_SEGMENT",
      status: 500,
      stage: "availability",
    };
  }

  const bookingResult = await createSquareBookingForTenant({
    tenantId,
    customerId: customerResult.customer.id,
    startAt: firstAvailability.start_at,
    locationId: firstAvailability.location_id,
    teamMemberId: firstSegment.team_member_id,
    serviceVariationId: firstSegment.service_variation_id,
    serviceVariationVersion: firstSegment.service_variation_version,
    durationMinutes: firstSegment.duration_minutes,
  });

  if (!bookingResult.ok) {
    return {
      ...bookingResult,
      stage: "booking",
    };
  }

  return {
    ok: true,
    customerId: customerResult.customer.id,
    availability: firstAvailability,
    booking: bookingResult.booking,
  };
}