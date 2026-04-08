import fetch from "node-fetch";
import type { SquareEnvironment } from "./searchSquareAvailability";

export type SquareCatalogObject = {
  type: string;
  id: string;
  version?: number;
  item_data?: {
    name?: string;
    variations?: Array<{
      id: string;
      type?: string;
      version?: number;
      item_variation_data?: {
        name?: string;
        service_duration?: number;
        available_for_booking?: boolean;
      };
    }>;
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
    const variationMap = new Map<string, SquareCatalogObject>();

    for (const obj of allObjects) {
      if (!obj?.id || !obj?.type) continue;
      if (obj.type === "ITEM") itemMap.set(obj.id, obj);
      if (obj.type === "ITEM_VARIATION") variationMap.set(obj.id, obj);
    }

    const services: SquareBookableService[] = [];

    for (const variation of variationMap.values()) {
      const variationData = variation.item_variation_data;
      const itemId = String(variationData?.item_id || "").trim();
      const item = itemMap.get(itemId);

      const itemName = String(item?.item_data?.name || "").trim();
      const variationName = String(variationData?.name || "").trim();
      const variationId = String(variation.id || "").trim();
      const variationVersion = Number(variation.version || 0);
      const availableForBooking = Boolean(variationData?.available_for_booking);
      const durationMinutes = toMinutesFromMs(variationData?.service_duration);

      if (!itemId || !variationId || !itemName) continue;

      services.push({
        itemId,
        itemName,
        variationId,
        variationName,
        variationVersion,
        durationMinutes,
        availableForBooking,
      });
    }

    return {
      ok: true,
      services: services.filter((service) => service.availableForBooking),
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