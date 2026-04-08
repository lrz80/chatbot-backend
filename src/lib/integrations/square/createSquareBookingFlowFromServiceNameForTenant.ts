// src/lib/integrations/square/createSquareBookingFlowFromServiceNameForTenant.ts
import { resolveSquareServiceMappingForTenant } from "./resolveSquareServiceMappingForTenant";
import { createSquareBookingFlowForTenant } from "./createSquareBookingFlowForTenant";

export type CreateSquareBookingFlowFromServiceNameForTenantArgs = {
  tenantId: string;
  serviceName: string;
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

export type CreateSquareBookingFlowFromServiceNameForTenantResult =
  Awaited<ReturnType<typeof createSquareBookingFlowForTenant>>;

export async function createSquareBookingFlowFromServiceNameForTenant(
  args: CreateSquareBookingFlowFromServiceNameForTenantArgs
): Promise<CreateSquareBookingFlowFromServiceNameForTenantResult> {
  const tenantId = String(args.tenantId || "").trim();
  const serviceName = String(args.serviceName || "").trim();
  const startAt = String(args.startAt || "").trim();
  const endAt = String(args.endAt || "").trim();
  const locationId = String(args.locationId || "").trim() || null;

  if (!tenantId || !serviceName || !startAt || !endAt) {
    return {
      ok: false,
      error: "MISSING_REQUIRED_FIELDS",
      status: 400,
    };
  }

  const serviceResult = await resolveSquareServiceMappingForTenant({
    tenantId,
    serviceName,
  });

  if (!serviceResult.ok) {
    return serviceResult;
  }

  return createSquareBookingFlowForTenant({
    tenantId,
    serviceVariationId: serviceResult.service.variationId,
    startAt,
    endAt,
    locationId,
    customer: args.customer,
  });
}