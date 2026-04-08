import fetch from "node-fetch";
import type { SquareEnvironment } from "./searchSquareAvailability";

export type CreateSquareCustomerArgs = {
  accessToken: string;
  environment: SquareEnvironment;
  givenName?: string;
  familyName?: string;
  email?: string;
  phoneNumber?: string;
};

type SquareCreateCustomerResponse = {
  customer?: {
    id: string;
    created_at: string;
    updated_at: string;
    given_name?: string;
    family_name?: string;
    email_address?: string;
    phone_number?: string;
    version?: number;
  };
  errors?: Array<{
    category?: string;
    code?: string;
    detail?: string;
    field?: string;
  }>;
};

export type CreateSquareCustomerResult =
  | {
      ok: true;
      customer: NonNullable<SquareCreateCustomerResponse["customer"]>;
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

export async function createSquareCustomer(
  args: CreateSquareCustomerArgs
): Promise<CreateSquareCustomerResult> {
  const accessToken = String(args.accessToken || "").trim();
  const environment = args.environment === "sandbox" ? "sandbox" : "production";
  const givenName = String(args.givenName || "").trim();
  const familyName = String(args.familyName || "").trim();
  const email = String(args.email || "").trim();
  const phoneNumber = String(args.phoneNumber || "").trim();

  if (!accessToken) {
    return {
      ok: false,
      error: "SQUARE_ACCESS_TOKEN_REQUIRED",
      status: 400,
    };
  }

  const baseUrl = getSquareApiBaseUrl(environment);

  try {
    const response = await fetch(`${baseUrl}/v2/customers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Square-Version": "2026-01-22",
      },
      body: JSON.stringify({
        given_name: givenName || "Test",
        family_name: familyName || "Customer",
        email_address: email || undefined,
        phone_number: phoneNumber || undefined,
      }),
    });

    const data = (await response.json()) as SquareCreateCustomerResponse;

    if (!response.ok || !data?.customer) {
      return {
        ok: false,
        error: "SQUARE_CREATE_CUSTOMER_FAILED",
        details: data?.errors || data,
        status: response.status,
      };
    }

    return {
      ok: true,
      customer: data.customer,
    };
  } catch (error) {
    console.error("[createSquareCustomer] unexpected error", error);
    return {
      ok: false,
      error: "SQUARE_CREATE_CUSTOMER_UNEXPECTED_ERROR",
      details: error instanceof Error ? error.message : error,
      status: 500,
    };
  }
}