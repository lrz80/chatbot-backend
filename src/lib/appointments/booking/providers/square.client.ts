//src/lib/appointments/booking/providers/square.client.ts
import fetch from "node-fetch";

export type SquareEnvironment = "sandbox" | "production";

type SquareRequestOptions = {
  accessToken: string;
  environment: SquareEnvironment;
  path: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
};

export type SquareApiSuccess<T = unknown> = {
  ok: true;
  status: number;
  data: T;
};

export type SquareApiError = {
  category?: string;
  code?: string;
  detail?: string;
  field?: string;
};

export type SquareApiFailure = {
  ok: false;
  status: number;
  error: string;
  details?: unknown;
  squareErrors?: SquareApiError[];
};

export type SquareApiResult<T = unknown> =
  | SquareApiSuccess<T>
  | SquareApiFailure;

export type SquareCreateBookingInput = {
  accessToken: string;
  environment: SquareEnvironment;
  idempotencyKey: string;
  locationId: string;
  customerId?: string | null;
  startAt: string;
  teamMemberId: string;
  serviceVariationId: string;
  serviceVariationVersion: number;
};

export type SquareRetrieveBookingInput = {
  accessToken: string;
  environment: SquareEnvironment;
  bookingId: string;
};

export type SquareCreateCustomerInput = {
  accessToken: string;
  environment: SquareEnvironment;
  givenName?: string | null;
  familyName?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
};

export type SquareSearchAvailabilityInput = {
  accessToken: string;
  environment: SquareEnvironment;
  startAt: string;
  endAt: string;
  locationId: string;
  teamMemberId?: string | null;
  serviceVariationId: string;
};

export type SquareTeamMemberBookingProfile = {
  team_member_id?: string;
  display_name?: string;
  description?: string;
  is_bookable?: boolean;
  profile_image_url?: string;
};

export type SquareListTeamMemberBookingProfilesResponse = {
  team_member_booking_profiles?: SquareTeamMemberBookingProfile[];
  cursor?: string;
};

function resolveSquareBaseUrl(environment: SquareEnvironment): string {
  return environment === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

function resolveSquareVersion(): string {
  return process.env.SQUARE_API_VERSION?.trim() || "2026-01-22";
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeNumber(value: number | string | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const parsed = Number(String(value || "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export async function squareRequest<T = unknown>(
  options: SquareRequestOptions
): Promise<SquareApiResult<T>> {
  const method = options.method || "GET";
  const baseUrl = resolveSquareBaseUrl(options.environment);
  const url = `${baseUrl}${options.path}`;
  const accessToken = String(options.accessToken || "").trim();

  if (!accessToken) {
    return {
      ok: false,
      status: 400,
      error: "SQUARE_ACCESS_TOKEN_MISSING",
    };
  }

  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Square-Version": resolveSquareVersion(),
        "Content-Type": "application/json",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const text = await response.text();
    const json = text ? safeJsonParse(text) : null;

    if (!response.ok) {
      const details = json ?? text;
      const squareErrors =
        details &&
        typeof details === "object" &&
        Array.isArray((details as any).errors)
          ? ((details as any).errors as SquareApiError[])
          : [];

      return {
        ok: false,
        status: response.status,
        error: "SQUARE_API_ERROR",
        details,
        squareErrors,
      };
    }

    return {
      ok: true,
      status: response.status,
      data: (json as T) ?? ({} as T),
    };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: "SQUARE_NETWORK_ERROR",
      details: error instanceof Error ? error.message : error,
    };
  }
}

export async function squareRetrieveLocation(args: {
  accessToken: string;
  environment: SquareEnvironment;
  locationId: string;
}): Promise<
  SquareApiResult<{
    location?: {
      id?: string;
      status?: string;
      name?: string;
      merchant_id?: string;
    };
  }>
> {
  const locationId = String(args.locationId || "").trim();

  if (!locationId) {
    return {
      ok: false,
      status: 400,
      error: "SQUARE_LOCATION_ID_MISSING",
    };
  }

  return squareRequest({
    accessToken: args.accessToken,
    environment: args.environment,
    path: `/v2/locations/${encodeURIComponent(locationId)}`,
    method: "GET",
  });
}

export async function squareSearchAvailability(args: SquareSearchAvailabilityInput): Promise<
  SquareApiResult<{
    availabilities?: Array<{
      start_at?: string;
      location_id?: string;
      appointment_segments?: Array<{
        duration_minutes?: number;
        service_variation_id?: string;
        team_member_id?: string;
        service_variation_version?: number;
      }>;
    }>;
  }>
> {
  const locationId = String(args.locationId || "").trim();
  const teamMemberId = String(args.teamMemberId || "").trim();
  const serviceVariationId = String(args.serviceVariationId || "").trim();
  const startAt = String(args.startAt || "").trim();
  const endAt = String(args.endAt || "").trim();

  if (!locationId || !serviceVariationId || !startAt || !endAt) {
    return {
      ok: false,
      status: 400,
      error: "SQUARE_AVAILABILITY_INPUT_MISSING",
      details: {
        hasLocationId: Boolean(locationId),
        hasServiceVariationId: Boolean(serviceVariationId),
        hasStartAt: Boolean(startAt),
        hasEndAt: Boolean(endAt),
      },
    };
  }

  return squareRequest({
    accessToken: args.accessToken,
    environment: args.environment,
    path: "/v2/bookings/availability/search",
    method: "POST",
    body: {
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
              ...(teamMemberId
                ? {
                    team_member_id_filter: {
                      any: [teamMemberId],
                    },
                  }
                : {}),
            },
          ],
        },
      },
    },
  });
}

export async function squareCreateCustomer(args: SquareCreateCustomerInput): Promise<
  SquareApiResult<{
    customer?: {
      id?: string;
      given_name?: string;
      family_name?: string;
      email_address?: string;
      phone_number?: string;
    };
  }>
> {
  const givenName = String(args.givenName || "").trim();
  const familyName = String(args.familyName || "").trim();
  const email = String(args.email || "").trim();
  const phoneNumber = String(args.phoneNumber || "").trim();

  if (!givenName && !familyName && !email && !phoneNumber) {
    return {
      ok: false,
      status: 400,
      error: "SQUARE_CUSTOMER_INPUT_MISSING",
    };
  }

  const customer: Record<string, unknown> = {};

  if (givenName) customer.given_name = givenName;
  if (familyName) customer.family_name = familyName;
  if (email) customer.email_address = email;
  if (phoneNumber) customer.phone_number = phoneNumber;

  return squareRequest({
    accessToken: args.accessToken,
    environment: args.environment,
    path: "/v2/customers",
    method: "POST",
    body: {
      idempotency_key: [
        "aamy",
        "square",
        "customer",
        email || phoneNumber || `${givenName}_${familyName}`,
      ]
        .map((part) => String(part || "").replace(/\s+/g, "_"))
        .join(":")
        .slice(0, 128),
      ...customer,
    },
  });
}

export async function squareCreateBooking(args: SquareCreateBookingInput): Promise<
  SquareApiResult<{
    booking?: {
      id?: string;
      location_id?: string;
      customer_id?: string;
      start_at?: string;
      status?: string;
      appointment_segments?: Array<{
        team_member_id?: string;
        service_variation_id?: string;
        service_variation_version?: number;
      }>;
    };
  }>
> {
  const locationId = String(args.locationId || "").trim();
  const teamMemberId = String(args.teamMemberId || "").trim();
  const serviceVariationId = String(args.serviceVariationId || "").trim();
  const serviceVariationVersion = normalizeNumber(args.serviceVariationVersion);
  const startAt = String(args.startAt || "").trim();
  const idempotencyKey = String(args.idempotencyKey || "").trim();

  if (
    !locationId ||
    !teamMemberId ||
    !serviceVariationId ||
    serviceVariationVersion == null ||
    !startAt ||
    !idempotencyKey
  ) {
    return {
      ok: false,
      status: 400,
      error: "SQUARE_CREATE_BOOKING_INPUT_MISSING",
      details: {
        hasLocationId: Boolean(locationId),
        hasTeamMemberId: Boolean(teamMemberId),
        hasServiceVariationId: Boolean(serviceVariationId),
        hasServiceVariationVersion: serviceVariationVersion != null,
        hasStartAt: Boolean(startAt),
        hasIdempotencyKey: Boolean(idempotencyKey),
      },
    };
  }

  const booking: Record<string, unknown> = {
    location_id: locationId,
    start_at: startAt,
    appointment_segments: [
      {
        team_member_id: teamMemberId,
        service_variation_id: serviceVariationId,
        service_variation_version: serviceVariationVersion,
      },
    ],
  };

  const customerId = String(args.customerId || "").trim();

  if (customerId) {
    booking.customer_id = customerId;
  }

  return squareRequest({
    accessToken: args.accessToken,
    environment: args.environment,
    path: "/v2/bookings",
    method: "POST",
    body: {
      idempotency_key: idempotencyKey,
      booking,
    },
  });
}

export async function squareRetrieveBooking(args: SquareRetrieveBookingInput): Promise<
  SquareApiResult<{
    booking?: {
      id?: string;
      location_id?: string;
      customer_id?: string;
      start_at?: string;
      status?: string;
      appointment_segments?: Array<{
        team_member_id?: string;
        service_variation_id?: string;
        service_variation_version?: number;
      }>;
    };
  }>
> {
  const bookingId = String(args.bookingId || "").trim();

  if (!bookingId) {
    return {
      ok: false,
      status: 400,
      error: "SQUARE_BOOKING_ID_MISSING",
    };
  }

  return squareRequest({
    accessToken: args.accessToken,
    environment: args.environment,
    path: `/v2/bookings/${encodeURIComponent(bookingId)}`,
    method: "GET",
  });
}

export async function squareListTeamMemberBookingProfiles(args: {
  accessToken: string;
  environment: SquareEnvironment;
}): Promise<SquareApiResult<SquareListTeamMemberBookingProfilesResponse>> {
  return squareRequest<SquareListTeamMemberBookingProfilesResponse>({
    accessToken: args.accessToken,
    environment: args.environment,
    path: "/v2/bookings/team-member-booking-profiles",
    method: "GET",
  });
}