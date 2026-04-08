// src/lib/integrations/square/searchSquareAvailabilityForTenant.ts
import { getSquareConnectionForTenant } from "./getSquareConnectionForTenant";
import {
  searchSquareAvailability,
  type SquareAvailability,
} from "./searchSquareAvailability";

export type SearchSquareAvailabilityForTenantArgs = {
  tenantId: string;
  locationId?: string | null;
  serviceVariationId: string;
  startAt: string;
  endAt: string;
};

export type SearchSquareAvailabilityForTenantResult =
  | {
      ok: true;
      availabilities: SquareAvailability[];
      firstAvailability: SquareAvailability | null;
    }
  | {
      ok: false;
      error: string;
      details?: unknown;
      status?: number;
    };

export async function searchSquareAvailabilityForTenant(
  args: SearchSquareAvailabilityForTenantArgs
): Promise<SearchSquareAvailabilityForTenantResult> {
  const tenantId = String(args.tenantId || "").trim();
  const locationId = String(args.locationId || "").trim();
  const serviceVariationId = String(args.serviceVariationId || "").trim();
  const startAt = String(args.startAt || "").trim();
  const endAt = String(args.endAt || "").trim();

  if (!tenantId || !serviceVariationId || !startAt || !endAt) {
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

  const availabilityResult = await searchSquareAvailability({
    accessToken: connection.accessToken,
    environment: connection.environment,
    locationId: resolvedLocationId,
    serviceVariationId,
    startAt,
    endAt,
  });

  if (!availabilityResult.ok) {
    return availabilityResult;
  }

  return {
    ok: true,
    availabilities: availabilityResult.availabilities,
    firstAvailability: availabilityResult.firstAvailability,
  };
}