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

export type SquareApiFailure = {
  ok: false;
  status: number;
  error: string;
  details?: unknown;
};

export type SquareApiResult<T = unknown> =
  | SquareApiSuccess<T>
  | SquareApiFailure;

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
      return {
        ok: false,
        status: response.status,
        error: "SQUARE_API_ERROR",
        details: json ?? text,
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