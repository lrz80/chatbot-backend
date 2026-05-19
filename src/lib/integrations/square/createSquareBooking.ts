// src/lib/integrations/square/createSquareBooking.ts
import crypto from "crypto";
import fetch from "node-fetch";
import type { SquareEnvironment } from "./searchSquareAvailability";

export type SquareBooking = {
  id: string;
  version: number;
  status: string;
  created_at: string;
  updated_at: string;
  location_id: string;
  customer_id: string;
  start_at: string;
  all_day: boolean;
  appointment_segments: Array<{
    duration_minutes: number;
    service_variation_id: string;
    team_member_id: string;
    service_variation_version: number;
    service_variation_client_id?: string;
    any_team_member?: boolean;
    intermission_minutes?: number;
  }>;
};

export type SquareApiError = {
  category?: string;
  code?: string;
  detail?: string;
  field?: string;
};

type SquareCreateBookingResponse = {
  booking?: SquareBooking;
  errors?: SquareApiError[];
};

export type CreateSquareBookingArgs = {
  accessToken: string;
  environment: SquareEnvironment;
  customerId: string;
  startAt: string;
  locationId: string;
  teamMemberId: string;
  serviceVariationId: string;
  serviceVariationVersion: number;
  durationMinutes: number;
};

export type CreateSquareBookingResult =
  | {
      ok: true;
      booking: SquareBooking;
    }
  | {
      ok: false;
      error: string;
      details?: unknown;
      squareErrors?: SquareApiError[];
      status?: number;
    };

function getSquareApiBaseUrl(environment: SquareEnvironment): string {
  return environment === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

export async function createSquareBooking(
  args: CreateSquareBookingArgs
): Promise<CreateSquareBookingResult> {
  const accessToken = String(args.accessToken || "").trim();
  const environment = args.environment === "sandbox" ? "sandbox" : "production";
  const customerId = String(args.customerId || "").trim();
  const startAt = String(args.startAt || "").trim();
  const locationId = String(args.locationId || "").trim();
  const teamMemberId = String(args.teamMemberId || "").trim();
  const serviceVariationId = String(args.serviceVariationId || "").trim();
  const serviceVariationVersion = Number(args.serviceVariationVersion);
  const durationMinutes = Number(args.durationMinutes);

  if (
    !accessToken ||
    !customerId ||
    !startAt ||
    !locationId ||
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

  const baseUrl = getSquareApiBaseUrl(environment);

  try {
    const response = await fetch(`${baseUrl}/v2/bookings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Square-Version": process.env.SQUARE_API_VERSION?.trim() || "2026-01-22",
      },
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        booking: {
          customer_id: customerId,
          start_at: startAt,
          location_id: locationId,
          appointment_segments: [
            {
              duration_minutes: durationMinutes,
              team_member_id: teamMemberId,
              service_variation_id: serviceVariationId,
              service_variation_version: serviceVariationVersion,
            },
          ],
        },
      }),
    });

    const data = (await response.json()) as SquareCreateBookingResponse;
    const squareErrors = Array.isArray(data?.errors) ? data.errors : [];

    if (!response.ok || !data?.booking) {
      return {
        ok: false,
        error: "SQUARE_CREATE_BOOKING_FAILED",
        details: data,
        squareErrors,
        status: response.status,
      };
    }

    return {
      ok: true,
      booking: data.booking,
    };
  } catch (error) {
    console.error("[createSquareBooking] unexpected error", error);

    return {
      ok: false,
      error: "SQUARE_CREATE_BOOKING_UNEXPECTED_ERROR",
      details: error instanceof Error ? error.message : error,
      squareErrors: [],
      status: 500,
    };
  }
}