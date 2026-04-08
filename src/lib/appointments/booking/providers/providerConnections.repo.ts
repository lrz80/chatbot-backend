import pool from "../../../../lib/db";
import type { BookingProvider } from "./types";

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

  return {
    id: String(rows[0].id),
    tenant_id: String(rows[0].tenant_id),
    provider: rows[0].provider as BookingProvider,
    status: rows[0].status as "active" | "inactive" | "error",
    external_account_id: rows[0].external_account_id ?? null,
    external_location_id: rows[0].external_location_id ?? null,
    access_token: rows[0].access_token ?? null,
    refresh_token: rows[0].refresh_token ?? null,
    token_expires_at: rows[0].token_expires_at
      ? new Date(rows[0].token_expires_at).toISOString()
      : null,
    metadata:
      rows[0].metadata && typeof rows[0].metadata === "object"
        ? rows[0].metadata
        : {},
    created_at: new Date(rows[0].created_at).toISOString(),
    updated_at: new Date(rows[0].updated_at).toISOString(),
  };
}