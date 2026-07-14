// src/lib/integrations/square/getSquareConnectionForTenant.ts

import {
  getBookingProviderConnection,
  getBookingProviderSecrets,
} from "../../appointments/booking/providers/providerConnections.repo";
import { getValidSquareAccessTokenForTenant } from "./getValidSquareAccessTokenForTenant";

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
        status: "active";
        metadata: Record<string, unknown>;
        tokenRefreshed: boolean;
      };
    }
  | {
      ok: false;
      status: number;
      error: string;
      details?: unknown;
    };

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export async function getSquareConnectionForTenant(
  tenantIdInput: string
): Promise<GetSquareConnectionForTenantResult> {
  const tenantId = clean(tenantIdInput);

  if (!tenantId) {
    return {
      ok: false,
      status: 400,
      error: "TENANT_ID_REQUIRED",
    };
  }

  /*
   * Primero validamos que exista una conexión activa.
   *
   * También necesitamos los datos no sensibles de la conexión:
   * merchantId, locationId y metadata.
   */
  const storedConnection = await getBookingProviderConnection(
    tenantId,
    "square"
  );

  if (!storedConnection) {
    return {
      ok: false,
      status: 404,
      error: "SQUARE_CONNECTION_NOT_FOUND",
    };
  }

  if (storedConnection.status !== "active") {
    return {
      ok: false,
      status: 409,
      error: "SQUARE_CONNECTION_NOT_ACTIVE",
      details: {
        status: storedConnection.status,
      },
    };
  }

  /*
   * Este helper revisa la expiración del access token.
   *
   * Si el token está vigente, lo devuelve.
   * Si está próximo a expirar o ya expiró, usa el refresh token,
   * guarda las nuevas credenciales y devuelve el nuevo access token.
   */
  const tokenResult = await getValidSquareAccessTokenForTenant(tenantId);

  if (!tokenResult.ok) {
    return {
      ok: false,
      status: tokenResult.status ?? 500,
      error: tokenResult.error,
      details: tokenResult.details,
    };
  }

  /*
   * Volvemos a leer los secretos porque el helper pudo haber renovado
   * y actualizado tanto refresh_token como token_expires_at.
   *
   * Esto mantiene el contrato actual del helper sin entregar información
   * desactualizada a los consumidores existentes.
   */
  const currentSecrets = await getBookingProviderSecrets(
    tenantId,
    "square"
  );

  return {
    ok: true,
    connection: {
      tenantId: storedConnection.tenant_id,
      accessToken: tokenResult.accessToken,
      refreshToken: currentSecrets?.refreshToken || null,
      merchantId: storedConnection.external_account_id,
      locationId: storedConnection.external_location_id,
      environment: tokenResult.environment,
      expiresAt:
        currentSecrets?.tokenExpiresAt ||
        storedConnection.token_expires_at ||
        null,
      status: "active",
      metadata: storedConnection.metadata || {},
      tokenRefreshed: tokenResult.refreshed,
    },
  };
}