import { resolveSquareServiceMappingFromDbForTenant } from "./resolveSquareServiceMappingFromDbForTenant";
import { createSquareBookingFlowForTenant } from "./createSquareBookingFlowForTenant";

export type CreateSquareBookingFlowFromInternalServiceForTenantArgs = {
  tenantId: string;
  internalServiceKey: string;
  startAt: string;
  endAt: string;
  customer: {
    givenName?: string;
    familyName?: string;
    email?: string;
    phoneNumber?: string;
  };
};

export type CreateSquareBookingFlowFromInternalServiceForTenantResult =
  Awaited<ReturnType<typeof createSquareBookingFlowForTenant>>;

export async function createSquareBookingFlowFromInternalServiceForTenant(
  args: CreateSquareBookingFlowFromInternalServiceForTenantArgs
): Promise<CreateSquareBookingFlowFromInternalServiceForTenantResult> {
  const tenantId = String(args.tenantId || "").trim();
  const internalServiceKey = String(args.internalServiceKey || "").trim();
  const startAt = String(args.startAt || "").trim();
  const endAt = String(args.endAt || "").trim();

  if (!tenantId || !internalServiceKey || !startAt || !endAt) {
    return {
      ok: false,
      error: "MISSING_REQUIRED_FIELDS",
      status: 400,
    };
  }

  const serviceResult = await resolveSquareServiceMappingFromDbForTenant({
    tenantId,
    internalServiceKey,
  });

  if (!serviceResult.ok) {
    return serviceResult;
  }

  return createSquareBookingFlowForTenant({
    tenantId,
    serviceVariationId: serviceResult.service.variationId,
    locationId: null,
    startAt,
    endAt,
    customer: args.customer,
  });
}