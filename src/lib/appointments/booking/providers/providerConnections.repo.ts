import pool from "../../../../lib/db";
import type { BookingProvider } from "./types";
import { encryptToken, decryptToken } from "../../../../services/googleCrypto";

export type BookingProviderConnection = {
  id: string;
  tenant_id: string;
  provider: BookingProvider;
  status: "active" | "inactive" | "error";
  external_account_id: string | null;
  external_location_id: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type BookingProviderSecrets = {
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
};

export type UpsertBookingProviderConnectionInput = {
  tenantId: string;
  provider: BookingProvider;
  status: "active" | "inactive" | "error";
  externalAccountId?: string | null;
  externalLocationId?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  tokenExpiresAt?: string | null;
  metadata?: Record<string, unknown>;
};

export async function getBookingProviderConnection(
  tenantId: string,
  provider: BookingProvider
): Promise<BookingProviderConnection | null> {
  const { rows } = await pool.query(
    `
      SELECT
        id,
        tenant_id,
        provider,
        status,
        external_account_id,
        external_location_id,
        access_token,
        refresh_token,
        token_expires_at,
        metadata,
        created_at,
        updated_at
      FROM booking_provider_connections
      WHERE tenant_id = $1
        AND provider = $2
      LIMIT 1
    `,
    [tenantId, provider]
  );

  if (!rows[0]) {
    return null;
  }

  return mapRow(rows[0]);
}

export async function getBookingProviderSecrets(
  tenantId: string,
  provider: BookingProvider
): Promise<BookingProviderSecrets | null> {
  const { rows } = await pool.query(
    `
      SELECT
        access_token,
        refresh_token,
        token_expires_at
      FROM booking_provider_connections
      WHERE tenant_id = $1
        AND provider = $2
      LIMIT 1
    `,
    [tenantId, provider]
  );

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    accessToken: row.access_token ? decryptToken(String(row.access_token)) : null,
    refreshToken: row.refresh_token ? decryptToken(String(row.refresh_token)) : null,
    tokenExpiresAt: row.token_expires_at
      ? new Date(row.token_expires_at).toISOString()
      : null,
  };
}

export async function upsertBookingProviderConnection(
  input: UpsertBookingProviderConnectionInput
): Promise<BookingProviderConnection> {
  const encryptedAccessToken =
    typeof input.accessToken === "string" && input.accessToken.trim()
      ? encryptToken(input.accessToken)
      : null;

  const encryptedRefreshToken =
    typeof input.refreshToken === "string" && input.refreshToken.trim()
      ? encryptToken(input.refreshToken)
      : null;

  const { rows } = await pool.query(
    `
      INSERT INTO booking_provider_connections (
        tenant_id,
        provider,
        status,
        external_account_id,
        external_location_id,
        access_token,
        refresh_token,
        token_expires_at,
        metadata,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW(), NOW()
      )
      ON CONFLICT (tenant_id, provider)
      DO UPDATE SET
        status = EXCLUDED.status,
        external_account_id = EXCLUDED.external_account_id,
        external_location_id = EXCLUDED.external_location_id,
        access_token = COALESCE(EXCLUDED.access_token, booking_provider_connections.access_token),
        refresh_token = COALESCE(EXCLUDED.refresh_token, booking_provider_connections.refresh_token),
        token_expires_at = EXCLUDED.token_expires_at,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING
        id,
        tenant_id,
        provider,
        status,
        external_account_id,
        external_location_id,
        access_token,
        refresh_token,
        token_expires_at,
        metadata,
        created_at,
        updated_at
    `,
    [
      input.tenantId,
      input.provider,
      input.status,
      input.externalAccountId ?? null,
      input.externalLocationId ?? null,
      encryptedAccessToken,
      encryptedRefreshToken,
      input.tokenExpiresAt ?? null,
      JSON.stringify(input.metadata ?? {}),
    ]
  );

  return mapRow(rows[0]);
}

function mapRow(row: any): BookingProviderConnection {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    provider: row.provider as BookingProvider,
    status: row.status as "active" | "inactive" | "error",
    external_account_id: row.external_account_id ?? null,
    external_location_id: row.external_location_id ?? null,
    access_token: row.access_token ?? null,
    refresh_token: row.refresh_token ?? null,
    token_expires_at: row.token_expires_at
      ? new Date(row.token_expires_at).toISOString()
      : null,
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? row.metadata
        : {},
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}