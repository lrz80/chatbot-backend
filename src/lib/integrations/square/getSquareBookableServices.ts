// src/lib/integrations/square/getSquareBookableServices.ts

import fetch from "node-fetch";
import type { SquareEnvironment } from "./searchSquareAvailability";

export type SquareCatalogObject = {
  type: string;
  id: string;
  version?: number;
  item_data?: {
    name?: string;
    variations?: SquareCatalogObject[];
  };
  item_variation_data?: {
    item_id?: string;
    name?: string;
    service_duration?: number;
    available_for_booking?: boolean;
  };
};

type SquareSearchCatalogResponse = {
  objects?: SquareCatalogObject[];
  related_objects?: SquareCatalogObject[];
  errors?: Array<{
    category?: string;
    code?: string;
    detail?: string;
    field?: string;
  }>;
};

export type SquareBookableService = {
  itemId: string;
  itemName: string;
  variationId: string;
  variationName: string;
  serviceName: string;
  searchText: string;
  variationVersion: number;
  durationMinutes: number | null;
  availableForBooking: boolean;
};

export type GetSquareBookableServicesArgs = {
  accessToken: string;
  environment: SquareEnvironment;
};

export type GetSquareBookableServicesResult =
  | {
      ok: true;
      services: SquareBookableService[];
      debug?: {
        itemCount: number;
        topLevelVariationCount: number;
        nestedVariationCount: number;
        totalVariationCount: number;
        bookableVariationCount: number;
      };
    }
  | {
      ok: false;
      error: string;
      details?: unknown;
      status?: number;
    };

function getSquareApiBaseUrl(environment: SquareEnvironment): string {
  return environment === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

function toMinutesFromMs(value?: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.round((value as number) / 60_000);
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function buildSquareServiceName(params: {
  itemName: string;
  variationName: string;
}): string {
  const itemName = clean(params.itemName);
  const variationName = clean(params.variationName);

  if (!variationName) return itemName;

  if (variationName.toLowerCase() === itemName.toLowerCase()) {
    return itemName;
  }

  return `${itemName} ${variationName}`.trim();
}

function buildSquareServiceSearchText(params: {
  itemName: string;
  variationName: string;
  serviceName: string;
}): string {
  return [params.serviceName, params.itemName, params.variationName]
    .map(clean)
    .filter(Boolean)
    .join(" | ");
}

function serviceNameDebugShouldLog(params: {
  itemName: string;
  variationName: string;
  variationId: string;
}): boolean {
  const debugServiceId = clean(process.env.SQUARE_DEBUG_SERVICE_VARIATION_ID);

  if (debugServiceId) {
    return clean(params.variationId) === debugServiceId;
  }

  return true;
}

function buildSquareBookableService(params: {
  item: SquareCatalogObject;
  variation: SquareCatalogObject;
  fallbackItemId?: string;
}): SquareBookableService | null {
  const { item, variation, fallbackItemId } = params;

  const variationData = variation.item_variation_data;

  const itemId = clean(variationData?.item_id || fallbackItemId || item.id);
  const itemName = clean(item.item_data?.name);
  const variationId = clean(variation.id);
  const variationName = clean(variationData?.name);
  const variationVersion = Number(variation.version || 0);
  const availableForBooking = variationData?.available_for_booking === true;
  const durationMinutes = toMinutesFromMs(variationData?.service_duration);

  if (!itemId || !variationId || !itemName) {
    return null;
  }

  const serviceName = buildSquareServiceName({
    itemName,
    variationName,
  });

  const searchText = buildSquareServiceSearchText({
    itemName,
    variationName,
    serviceName,
  });

  return {
    itemId,
    itemName,
    variationId,
    variationName,
    serviceName,
    searchText,
    variationVersion,
    durationMinutes,
    availableForBooking,
  };
}

export async function getSquareBookableServices(
  args: GetSquareBookableServicesArgs
): Promise<GetSquareBookableServicesResult> {
  const accessToken = String(args.accessToken || "").trim();
  const environment = args.environment === "sandbox" ? "sandbox" : "production";

  if (!accessToken) {
    return {
      ok: false,
      error: "SQUARE_ACCESS_TOKEN_REQUIRED",
      status: 400,
    };
  }

  const baseUrl = getSquareApiBaseUrl(environment);

  try {
    const response = await fetch(`${baseUrl}/v2/catalog/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Square-Version": "2026-03-18",
      },
      body: JSON.stringify({
        object_types: ["ITEM", "ITEM_VARIATION"],
        include_related_objects: true,
      }),
    });

    const data = (await response.json()) as SquareSearchCatalogResponse;

    if (!response.ok) {
      return {
        ok: false,
        error: "SQUARE_GET_BOOKABLE_SERVICES_FAILED",
        details: data?.errors || data,
        status: response.status,
      };
    }

    const objects = Array.isArray(data.objects) ? data.objects : [];
    const relatedObjects = Array.isArray(data.related_objects)
      ? data.related_objects
      : [];

    const allObjects = [...objects, ...relatedObjects];

    const itemMap = new Map<string, SquareCatalogObject>();
    const topLevelVariationMap = new Map<string, SquareCatalogObject>();

    for (const obj of allObjects) {
      if (!obj?.id || !obj?.type) continue;

      if (obj.type === "ITEM") {
        itemMap.set(obj.id, obj);
      }

      if (obj.type === "ITEM_VARIATION") {
        topLevelVariationMap.set(obj.id, obj);
      }
    }

    const servicesByVariationId = new Map<string, SquareBookableService>();

    let nestedVariationCount = 0;

    /**
     * 1) Process variations nested inside ITEM.item_data.variations.
     * Square often returns service variations nested under the ITEM object.
     */
    for (const item of itemMap.values()) {
      const nestedVariations = Array.isArray(item.item_data?.variations)
        ? item.item_data?.variations || []
        : [];

      for (const variation of nestedVariations) {
        if (!variation?.id) continue;

        nestedVariationCount += 1;

        const service = buildSquareBookableService({
          item,
          variation,
          fallbackItemId: item.id,
        });

        if (!service) continue;

        servicesByVariationId.set(service.variationId, service);
      }
    }

    /**
     * 2) Process top-level ITEM_VARIATION objects too.
     * This covers catalog responses where variations are returned separately.
     */
    for (const variation of topLevelVariationMap.values()) {
      const variationData = variation.item_variation_data;
      const itemId = clean(variationData?.item_id);
      const item = itemMap.get(itemId);

      if (!item) continue;

      const service = buildSquareBookableService({
        item,
        variation,
        fallbackItemId: itemId,
      });

      if (!service) continue;

      servicesByVariationId.set(service.variationId, service);
    }

    const allServices = Array.from(servicesByVariationId.values());
    const bookableServices = allServices.filter(
      (service) => service.availableForBooking
    );

    return {
      ok: true,
      services: bookableServices,
      debug: {
        itemCount: itemMap.size,
        topLevelVariationCount: topLevelVariationMap.size,
        nestedVariationCount,
        totalVariationCount: allServices.length,
        bookableVariationCount: bookableServices.length,
      },
    };
  } catch (error) {
    console.error("[getSquareBookableServices] unexpected error", error);

    return {
      ok: false,
      error: "SQUARE_GET_BOOKABLE_SERVICES_UNEXPECTED_ERROR",
      details: error instanceof Error ? error.message : error,
      status: 500,
    };
  }
}