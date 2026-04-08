// src/lib/integrations/square/createSquareCustomerForTenant.ts
import { getSquareConnectionForTenant } from "./getSquareConnectionForTenant";
import {
  createSquareCustomer,
  type CreateSquareCustomerResult,
} from "./createSquareCustomer";

export type CreateSquareCustomerForTenantArgs = {
  tenantId: string;
  givenName?: string;
  familyName?: string;
  email?: string;
  phoneNumber?: string;
};

export type CreateSquareCustomerForTenantResult = CreateSquareCustomerResult;

export async function createSquareCustomerForTenant(
  args: CreateSquareCustomerForTenantArgs
): Promise<CreateSquareCustomerForTenantResult> {
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

  return createSquareCustomer({
    accessToken: connection.accessToken,
    environment: connection.environment,
    givenName,
    familyName,
    email,
    phoneNumber,
  });
}