//src/lib/integrations/square/resolveSquareServiceMappingFromDbForTenant.ts
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

export type ResolvedSquareExternalMapping = {
  externalServiceId: string;
  externalServiceVersion: number | null;
  externalLocationId: string | null;
  externalMetadata: Record<string, unknown>;
};

export type ResolveSquareServiceMappingFromDbForTenantResult =
  | {
      ok: true;
      service: SquareBookableService;
      mapping: ResolvedSquareExternalMapping;
    }
  | {
      ok: false;
      error: string;
      status?: number;
      details?: unknown;
    };

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const parsed = Number(String(value || "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

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

  const rawMapping = mappingResult.mapping as any;

  const externalServiceId = String(rawMapping.externalServiceId || "").trim();
  const externalServiceVersion = normalizeNumber(rawMapping.externalServiceVersion);
  const externalLocationId =
    String(rawMapping.externalLocationId || "").trim() || null;
  const externalMetadata = normalizeMetadata(rawMapping.externalMetadata);

  if (!externalServiceId) {
    return {
      ok: false,
      error: "SQUARE_MAPPING_MISSING_EXTERNAL_SERVICE_ID",
      status: 400,
    };
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
    (item) => item.variationId === externalServiceId
  );

  if (!service) {
    return {
      ok: false,
      error: "SQUARE_MAPPED_SERVICE_NOT_FOUND",
      status: 404,
      details: {
        externalServiceId,
      },
    };
  }

  return {
    ok: true,
    service,
    mapping: {
      externalServiceId,
      externalServiceVersion,
      externalLocationId,
      externalMetadata,
    },
  };
}