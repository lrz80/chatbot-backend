import { getSquareConnectionForTenant } from "./getSquareConnectionForTenant";
import { createSquareCustomer } from "./createSquareCustomer";
import {
  findSquareCustomerByContact,
  type SquareCustomer,
} from "./findSquareCustomerByContact";

export type GetOrCreateSquareCustomerForTenantArgs = {
  tenantId: string;
  givenName?: string;
  familyName?: string;
  email?: string;
  phoneNumber?: string;
};

export type GetOrCreateSquareCustomerForTenantResult =
  | {
      ok: true;
      customer: SquareCustomer;
      source: "existing" | "created";
    }
  | {
      ok: false;
      error: string;
      details?: unknown;
      status?: number;
    };

export async function getOrCreateSquareCustomerForTenant(
  args: GetOrCreateSquareCustomerForTenantArgs
): Promise<GetOrCreateSquareCustomerForTenantResult> {
  const tenantId = String(args.tenantId || "").trim();
  const givenName = String(args.givenName || "").trim();
  const familyName = String(args.familyName || "").trim();
  const email = String(args.email || "").trim();
  const phoneNumber = String(args.phoneNumber || "").trim();

  if (!tenantId) {
    return {
      ok: false,
      error: "TENANT_ID_REQUIRED",
      status: 400,
    };
  }

  const connectionResult = await getSquareConnectionForTenant(tenantId);

  if (!connectionResult.ok) {
    return connectionResult;
  }

  const connection = connectionResult.connection;

  const findResult = await findSquareCustomerByContact({
    accessToken: connection.accessToken,
    environment: connection.environment,
    email,
    phoneNumber,
  });

  if (!findResult.ok) {
    return findResult;
  }

  if (findResult.customer) {
    return {
      ok: true,
      customer: findResult.customer,
      source: "existing",
    };
  }

  const createResult = await createSquareCustomer({
    accessToken: connection.accessToken,
    environment: connection.environment,
    givenName,
    familyName,
    email,
    phoneNumber,
  });

  if (!createResult.ok) {
    return createResult;
  }

  return {
    ok: true,
    customer: createResult.customer,
    source: "created",
  };
}