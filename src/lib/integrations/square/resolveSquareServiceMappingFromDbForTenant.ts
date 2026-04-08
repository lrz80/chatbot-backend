import { getTenantExternalServiceMapping } from "../serviceMappings/getTenantExternalServiceMapping";
import { getSquareConnectionForTenant } from "./getSquareConnectionForTenant";
import {
  getSquareBookableServices,
  type SquareBookableService,
} from "./getSquareBookableServices";

export type ResolveSquareServiceMappingFromDbForTenantArgs = {
  tenantId: string;
  internalServiceKey: string;
};

export type ResolveSquareServiceMappingFromDbForTenantResult =
  | {
      ok: true;
      service: SquareBookableService;
    }
  | {
      ok: false;
      error: string;
      status?: number;
      details?: unknown;
    };

export async function resolveSquareServiceMappingFromDbForTenant(
  args: ResolveSquareServiceMappingFromDbForTenantArgs
): Promise<ResolveSquareServiceMappingFromDbForTenantResult> {
  const tenantId = String(args.tenantId || "").trim();
  const internalServiceKey = String(args.internalServiceKey || "").trim();

  if (!tenantId || !internalServiceKey) {
    return {
      ok: false,
      error: "MISSING_REQUIRED_FIELDS",
      status: 400,
    };
  }

  const mappingResult = await getTenantExternalServiceMapping({
    tenantId,
    provider: "square",
    internalServiceKey,
  });

  if (!mappingResult.ok) {
    return mappingResult;
  }

  const connectionResult = await getSquareConnectionForTenant(tenantId);

  if (!connectionResult.ok) {
    return connectionResult;
  }

  const servicesResult = await getSquareBookableServices({
    accessToken: connectionResult.connection.accessToken,
    environment: connectionResult.connection.environment,
  });

  if (!servicesResult.ok) {
    return servicesResult;
  }

  const service = servicesResult.services.find(
    (item) => item.variationId === mappingResult.mapping.externalServiceId
  );

  if (!service) {
    return {
      ok: false,
      error: "SQUARE_MAPPED_SERVICE_NOT_FOUND",
      status: 404,
    };
  }

  return {
    ok: true,
    service,
  };
}