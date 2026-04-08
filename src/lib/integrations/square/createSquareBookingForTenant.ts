// src/lib/integrations/square/createSquareBookingForTenant.ts
import { getSquareConnectionForTenant } from "./getSquareConnectionForTenant";
import {
  createSquareBooking,
  type SquareBooking,
} from "./createSquareBooking";

export type CreateSquareBookingForTenantArgs = {
  tenantId: string;
  customerId: string;
  startAt: string;
  locationId?: string | null;
  teamMemberId: string;
  serviceVariationId: string;
  serviceVariationVersion: number;
  durationMinutes: number;
};

export type CreateSquareBookingForTenantResult =
  | {
      ok: true;
      booking: SquareBooking;
    }
  | {
      ok: false;
      error: string;
      details?: unknown;
      status?: number;
    };

export async function createSquareBookingForTenant(
  args: CreateSquareBookingForTenantArgs
): Promise<CreateSquareBookingForTenantResult> {
  const tenantId = String(args.tenantId || "").trim();
  const customerId = String(args.customerId || "").trim();
  const startAt = String(args.startAt || "").trim();
  const locationId = String(args.locationId || "").trim();
  const teamMemberId = String(args.teamMemberId || "").trim();
  const serviceVariationId = String(args.serviceVariationId || "").trim();
  const serviceVariationVersion = Number(args.serviceVariationVersion);
  const durationMinutes = Number(args.durationMinutes);

  if (
    !tenantId ||
    !customerId ||
    !startAt ||
    !teamMemberId ||
    !serviceVariationId ||
    !Number.isFinite(serviceVariationVersion) ||
    !Number.isFinite(durationMinutes)
  ) {
    return {
      ok: false,
      error: "MISSING_REQUIRED_FIELDS",
      status: 400,
    };
  }

  const connectionResult = await getSquareConnectionForTenant(tenantId);

  if (!connectionResult.ok) {
    return connectionResult;
  }

  const connection = connectionResult.connection;
  const resolvedLocationId = locationId || String(connection.locationId || "").trim();

  if (!resolvedLocationId) {
    return {
      ok: false,
      error: "SQUARE_LOCATION_ID_REQUIRED",
      status: 400,
    };
  }

  const bookingResult = await createSquareBooking({
    accessToken: connection.accessToken,
    environment: connection.environment,
    customerId,
    startAt,
    locationId: resolvedLocationId,
    teamMemberId,
    serviceVariationId,
    serviceVariationVersion,
    durationMinutes,
  });

  if (!bookingResult.ok) {
    return bookingResult;
  }

  return {
    ok: true,
    booking: bookingResult.booking,
  };
}