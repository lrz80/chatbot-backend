// src/lib/integrations/square/resolveSquareServiceMappingForTenant.ts
import { getSquareConnectionForTenant } from "./getSquareConnectionForTenant";
import {
  getSquareBookableServices,
  type SquareBookableService,
} from "./getSquareBookableServices";

export type ResolveSquareServiceMappingForTenantArgs = {
  tenantId: string;
  serviceVariationId?: string | null;
  serviceName?: string | null;
};

export type ResolveSquareServiceMappingForTenantResult =
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

function normalizeText(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

export async function resolveSquareServiceMappingForTenant(
  args: ResolveSquareServiceMappingForTenantArgs
): Promise<ResolveSquareServiceMappingForTenantResult> {
  const tenantId = String(args.tenantId || "").trim();
  const serviceVariationId = String(args.serviceVariationId || "").trim();
  const serviceName = String(args.serviceName || "").trim();

  if (!tenantId) {
    return {
      ok: false,
      error: "TENANT_ID_REQUIRED",
      status: 400,
    };
  }

  if (!serviceVariationId && !serviceName) {
    return {
      ok: false,
      error: "SERVICE_IDENTIFIER_REQUIRED",
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

  const services = servicesResult.services;

  if (serviceVariationId) {
    const directMatch = services.find(
      (service) => service.variationId === serviceVariationId
    );

    if (!directMatch) {
      return {
        ok: false,
        error: "SQUARE_SERVICE_VARIATION_NOT_FOUND",
        status: 404,
      };
    }

    return {
      ok: true,
      service: directMatch,
    };
  }

  const target = normalizeText(serviceName);

  const exactMatch = services.find((service) => {
    return (
      normalizeText(service.itemName) === target ||
      normalizeText(service.variationName) === target ||
      normalizeText(`${service.itemName} ${service.variationName}`) === target
    );
  });

  if (exactMatch) {
    return {
      ok: true,
      service: exactMatch,
    };
  }

  const containsMatch = services.find((service) => {
    const itemName = normalizeText(service.itemName);
    const variationName = normalizeText(service.variationName);
    const combined = normalizeText(`${service.itemName} ${service.variationName}`);

    return (
      itemName.includes(target) ||
      variationName.includes(target) ||
      combined.includes(target) ||
      target.includes(itemName) ||
      target.includes(variationName)
    );
  });

  if (containsMatch) {
    return {
      ok: true,
      service: containsMatch,
    };
  }

  return {
    ok: false,
    error: "SQUARE_SERVICE_NOT_FOUND",
    status: 404,
  };
}