//src/lib/integrations/square/getSquareConnectionForTenant.ts
import {
  getBookingProviderConnection,
  getBookingProviderSecrets,
} from "../../appointments/booking/providers/providerConnections.repo";

type SquareEnvironment = "sandbox" | "production";

type GetSquareConnectionForTenantResult =
  | {
      ok: true;
      connection: {
        tenantId: string;
        accessToken: string;
        refreshToken: string | null;
        merchantId: string | null;
        locationId: string | null;
        environment: SquareEnvironment;
        expiresAt: string | null;
        status: "active" | "inactive" | "error";
        metadata: Record<string, unknown>;
      };
    }
  | {
      ok: false;
      status: number;
      error: string;
      details?: unknown;
    };

function resolveSquareEnvironment(value: unknown): SquareEnvironment {
  return value === "sandbox" ? "sandbox" : "production";
}

export async function getSquareConnectionForTenant(
  tenantIdInput: string
): Promise<GetSquareConnectionForTenantResult> {
  const tenantId = String(tenantIdInput || "").trim();

  if (!tenantId) {
    return {
      ok: false,
      status: 400,
      error: "TENANT_ID_REQUIRED",
    };
  }

  const connection = await getBookingProviderConnection(tenantId, "square");

  if (!connection) {
    return {
      ok: false,
      status: 404,
      error: "SQUARE_CONNECTION_NOT_FOUND",
    };
  }

  if (connection.status !== "active") {
    return {
      ok: false,
      status: 409,
      error: "SQUARE_CONNECTION_NOT_ACTIVE",
      details: {
        status: connection.status,
      },
    };
  }

  const secrets = await getBookingProviderSecrets(tenantId, "square");

  const accessToken = String(secrets?.accessToken || "").trim();

  if (!accessToken) {
    return {
      ok: false,
      status: 400,
      error: "SQUARE_ACCESS_TOKEN_MISSING",
    };
  }

  return {
    ok: true,
    connection: {
      tenantId: connection.tenant_id,
      accessToken,
      refreshToken: secrets?.refreshToken || null,
      merchantId: connection.external_account_id,
      locationId: connection.external_location_id,
      environment: resolveSquareEnvironment(connection.metadata?.environment),
      expiresAt: secrets?.tokenExpiresAt || connection.token_expires_at || null,
      status: connection.status,
      metadata: connection.metadata || {},
    },
  };
}