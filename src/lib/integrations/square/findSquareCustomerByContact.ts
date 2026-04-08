import fetch from "node-fetch";
import type { SquareEnvironment } from "./searchSquareAvailability";

export type SquareCustomer = {
  id: string;
  created_at?: string;
  updated_at?: string;
  given_name?: string;
  family_name?: string;
  email_address?: string;
  phone_number?: string;
  version?: number;
};

type SquareSearchCustomersResponse = {
  customers?: SquareCustomer[];
  errors?: Array<{
    category?: string;
    code?: string;
    detail?: string;
    field?: string;
  }>;
};

export type FindSquareCustomerByContactArgs = {
  accessToken: string;
  environment: SquareEnvironment;
  email?: string;
  phoneNumber?: string;
};

export type FindSquareCustomerByContactResult =
  | {
      ok: true;
      customer: SquareCustomer | null;
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

export async function findSquareCustomerByContact(
  args: FindSquareCustomerByContactArgs
): Promise<FindSquareCustomerByContactResult> {
  const accessToken = String(args.accessToken || "").trim();
  const environment = args.environment === "sandbox" ? "sandbox" : "production";
  const email = String(args.email || "").trim();
  const phoneNumber = String(args.phoneNumber || "").trim();

  if (!accessToken) {
    return {
      ok: false,
      error: "SQUARE_ACCESS_TOKEN_REQUIRED",
      status: 400,
    };
  }

  if (!email && !phoneNumber) {
    return {
      ok: true,
      customer: null,
    };
  }

  const baseUrl = getSquareApiBaseUrl(environment);

  try {
    const response = await fetch(`${baseUrl}/v2/customers/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Square-Version": "2026-01-22",
      },
      body: JSON.stringify({
        query: {
          filter: {
            ...(email
              ? {
                  email_address: {
                    exact: email,
                  },
                }
              : {}),
            ...(phoneNumber
              ? {
                  phone_number: {
                    exact: phoneNumber,
                  },
                }
              : {}),
          },
          sort: {
            field: "CREATED_AT",
            order: "DESC",
          },
        },
        limit: 1,
      }),
    });

    const data = (await response.json()) as SquareSearchCustomersResponse;

    if (!response.ok) {
      return {
        ok: false,
        error: "SQUARE_FIND_CUSTOMER_FAILED",
        details: data?.errors || data,
        status: response.status,
      };
    }

    const customer = Array.isArray(data.customers) ? data.customers[0] || null : null;

    return {
      ok: true,
      customer,
    };
  } catch (error) {
    console.error("[findSquareCustomerByContact] unexpected error", error);
    return {
      ok: false,
      error: "SQUARE_FIND_CUSTOMER_UNEXPECTED_ERROR",
      details: error instanceof Error ? error.message : error,
      status: 500,
    };
  }
}