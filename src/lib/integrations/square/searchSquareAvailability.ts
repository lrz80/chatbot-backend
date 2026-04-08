// src/lib/integrations/square/searchSquareAvailability.ts
import fetch from "node-fetch";

export type SquareEnvironment = "sandbox" | "production";

export type SquareAppointmentSegment = {
  duration_minutes: number;
  team_member_id: string;
  service_variation_id: string;
  service_variation_version: number;
};

export type SquareAvailability = {
  start_at: string;
  location_id: string;
  appointment_segments: SquareAppointmentSegment[];
};

type SquareSearchAvailabilityResponse = {
  availabilities?: SquareAvailability[];
  errors?: Array<{
    category?: string;
    code?: string;
    detail?: string;
    field?: string;
  }>;
};

export type SearchSquareAvailabilityArgs = {
  accessToken: string;
  environment: SquareEnvironment;
  locationId: string;
  serviceVariationId: string;
  startAt: string;
  endAt: string;
};

export type SearchSquareAvailabilityResult =
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

function getSquareApiBaseUrl(environment: SquareEnvironment): string {
  return environment === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

function isValidIsoDate(value: string): boolean {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && value.includes("T");
}

export async function searchSquareAvailability(
  args: SearchSquareAvailabilityArgs
): Promise<SearchSquareAvailabilityResult> {
  const accessToken = String(args.accessToken || "").trim();
  const environment = args.environment === "sandbox" ? "sandbox" : "production";
  const locationId = String(args.locationId || "").trim();
  const serviceVariationId = String(args.serviceVariationId || "").trim();
  const startAt = String(args.startAt || "").trim();
  const endAt = String(args.endAt || "").trim();

  if (!accessToken) {
    return {
      ok: false,
      error: "SQUARE_ACCESS_TOKEN_REQUIRED",
      status: 400,
    };
  }

  if (!locationId) {
    return {
      ok: false,
      error: "SQUARE_LOCATION_ID_REQUIRED",
      status: 400,
    };
  }

  if (!serviceVariationId) {
    return {
      ok: false,
      error: "SQUARE_SERVICE_VARIATION_ID_REQUIRED",
      status: 400,
    };
  }

  if (!isValidIsoDate(startAt) || !isValidIsoDate(endAt)) {
    return {
      ok: false,
      error: "INVALID_DATE_RANGE",
      status: 400,
    };
  }

  const baseUrl = getSquareApiBaseUrl(environment);

  try {
    const response = await fetch(`${baseUrl}/v2/bookings/availability/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Square-Version": "2026-01-22",
      },
      body: JSON.stringify({
        query: {
          filter: {
            start_at_range: {
              start_at: startAt,
              end_at: endAt,
            },
            location_id: locationId,
            segment_filters: [
              {
                service_variation_id: serviceVariationId,
              },
            ],
          },
        },
      }),
    });

    const data =
      (await response.json()) as SquareSearchAvailabilityResponse;

    if (!response.ok) {
      return {
        ok: false,
        error: "SQUARE_AVAILABILITY_SEARCH_FAILED",
        details: data?.errors || data,
        status: response.status,
      };
    }

    const availabilities = Array.isArray(data?.availabilities)
      ? data.availabilities
      : [];

    return {
      ok: true,
      availabilities,
      firstAvailability: availabilities[0] || null,
    };
  } catch (error) {
    console.error("[searchSquareAvailability] unexpected error", error);
    return {
      ok: false,
      error: "SQUARE_AVAILABILITY_UNEXPECTED_ERROR",
      details: error instanceof Error ? error.message : error,
      status: 500,
    };
  }
}