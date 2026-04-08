import pool from "../../db";

export type SquareEnvironment = "sandbox" | "production";

export type SquareTenantConnection = {
  tenantId: string;
  accessToken: string;
  refreshToken: string | null;
  merchantId: string | null;
  locationId: string | null;
  expiresAt: string | null;
  environment: SquareEnvironment;
  status: string | null;
};

export type GetSquareConnectionForTenantResult =
  | {
      ok: true;
      connection: SquareTenantConnection;
    }
  | {
      ok: false;
      error: string;
      status?: number;
    };

export async function getSquareConnectionForTenant(
  tenantId: string
): Promise<GetSquareConnectionForTenantResult> {
  const normalizedTenantId = String(tenantId || "").trim();

  if (!normalizedTenantId) {
    return {
      ok: false,
      error: "TENANT_ID_REQUIRED",
      status: 400,
    };
  }

  const result = await pool.query(
    `
    SELECT
      id,
      square_access_token,
      square_refresh_token,
      square_merchant_id,
      square_location_id,
      square_token_expires_at,
      square_environment,
      square_status
    FROM tenants
    WHERE id = $1
    LIMIT 1
    `,
    [normalizedTenantId]
  );

  const row = result.rows[0];

  if (!row) {
    return {
      ok: false,
      error: "TENANT_NOT_FOUND",
      status: 404,
    };
  }

  const accessToken = String(row.square_access_token || "").trim();
  const environment =
    String(row.square_environment || "").trim().toLowerCase() === "sandbox"
      ? "sandbox"
      : "production";

  if (!accessToken) {
    return {
      ok: false,
      error: "SQUARE_NOT_CONNECTED",
      status: 404,
    };
  }

  return {
    ok: true,
    connection: {
      tenantId: String(row.id),
      accessToken,
      refreshToken: row.square_refresh_token
        ? String(row.square_refresh_token)
        : null,
      merchantId: row.square_merchant_id ? String(row.square_merchant_id) : null,
      locationId: row.square_location_id ? String(row.square_location_id) : null,
      expiresAt: row.square_token_expires_at
        ? new Date(row.square_token_expires_at).toISOString()
        : null,
      environment,
      status: row.square_status ? String(row.square_status) : null,
    },
  };
}