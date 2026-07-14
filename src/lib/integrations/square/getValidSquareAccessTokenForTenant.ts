// src/lib/integrations/square/getValidSquareAccessTokenForTenant.ts

import fetch from "node-fetch";
import {
  getBookingProviderConnection,
  getBookingProviderSecrets,
  updateBookingProviderTokens,
} from "../../appointments/booking/providers/providerConnections.repo";

export type SquareEnvironment = "sandbox" | "production";

type SquareRefreshTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_at?: string;
  merchant_id?: string;
  refresh_token?: string;
  short_lived?: boolean;
  errors?: Array<{
    category?: string;
    code?: string;
    detail?: string;
    field?: string;
  }>;
};

export type GetValidSquareAccessTokenResult =
  | {
      ok: true;
      accessToken: string;
      environment: SquareEnvironment;
      refreshed: boolean;
    }
  | {
      ok: false;
      error: string;
      status?: number;
      details?: unknown;
    };

const REFRESH_BEFORE_EXPIRATION_MS = 24 * 60 * 60 * 1000;

const refreshPromises = new Map<
  string,
  Promise<GetValidSquareAccessTokenResult>
>();

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function getSquareApiVersion(): string {
  return clean(process.env.SQUARE_API_VERSION) || "2026-03-18";
}

function getSquareEnvironment(
  metadata: Record<string, unknown>
): SquareEnvironment {
  return metadata?.environment === "sandbox"
    ? "sandbox"
    : "production";
}

function getSquareConfig(environment: SquareEnvironment): {
  appId: string;
  appSecret: string;
  apiBaseUrl: string;
} {
  const sandbox = environment === "sandbox";

  const appId = clean(
    sandbox
      ? process.env.SQUARE_SANDBOX_APPLICATION_ID
      : process.env.SQUARE_PRODUCTION_APPLICATION_ID ||
          process.env.SQUARE_APPLICATION_ID
  );

  const appSecret = clean(
    sandbox
      ? process.env.SQUARE_SANDBOX_APPLICATION_SECRET
      : process.env.SQUARE_PRODUCTION_APPLICATION_SECRET ||
          process.env.SQUARE_APPLICATION_SECRET
  );

  const apiBaseUrl = sandbox
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";

  if (!appId || !appSecret) {
    throw new Error(
      `Missing Square OAuth credentials for environment=${environment}`
    );
  }

  return {
    appId,
    appSecret,
    apiBaseUrl,
  };
}

function shouldRefreshToken(expiresAt: string | null): boolean {
  if (!expiresAt) {
    return true;
  }

  const expirationMs = new Date(expiresAt).getTime();

  if (!Number.isFinite(expirationMs)) {
    return true;
  }

  return expirationMs - Date.now() <= REFRESH_BEFORE_EXPIRATION_MS;
}

async function refreshSquareAccessToken(params: {
  tenantId: string;
  environment: SquareEnvironment;
  refreshToken: string;
}): Promise<GetValidSquareAccessTokenResult> {
  const { tenantId, environment, refreshToken } = params;
  const config = getSquareConfig(environment);

  const response = await fetch(`${config.apiBaseUrl}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Square-Version": getSquareApiVersion(),
    },
    body: JSON.stringify({
      client_id: config.appId,
      client_secret: config.appSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const responseText = await response.text();

  let data: SquareRefreshTokenResponse;

  try {
    data = responseText
      ? (JSON.parse(responseText) as SquareRefreshTokenResponse)
      : {};
  } catch {
    data = {
      errors: [
        {
          category: "API_ERROR",
          code: "INVALID_RESPONSE",
          detail: responseText,
        },
      ],
    };
  }

  const accessToken = clean(data.access_token);

  if (!response.ok || !accessToken) {
    console.error("[SQUARE][TOKEN_REFRESH_FAILED]", {
      tenantId,
      environment,
      status: response.status,
      errors: data.errors,
    });

    return {
      ok: false,
      error: "SQUARE_TOKEN_REFRESH_FAILED",
      status: response.status,
      details: data.errors || data,
    };
  }

  const nextRefreshToken =
    clean(data.refresh_token) || refreshToken;

  const expiresAt = clean(data.expires_at) || null;

  const updated = await updateBookingProviderTokens({
    tenantId,
    provider: "square",
    accessToken,
    refreshToken: nextRefreshToken,
    tokenExpiresAt: expiresAt,
  });

  if (!updated) {
    return {
      ok: false,
      error: "SQUARE_REFRESHED_TOKEN_SAVE_FAILED",
      status: 500,
    };
  }

  console.log("[SQUARE][TOKEN_REFRESHED]", {
    tenantId,
    environment,
    expiresAt,
  });

  return {
    ok: true,
    accessToken,
    environment,
    refreshed: true,
  };
}

async function resolveValidSquareAccessToken(
  tenantId: string
): Promise<GetValidSquareAccessTokenResult> {
  const connection = await getBookingProviderConnection(
    tenantId,
    "square"
  );

  if (!connection || connection.status !== "active") {
    return {
      ok: false,
      error: "SQUARE_CONNECTION_NOT_FOUND",
      status: 404,
    };
  }

  const secrets = await getBookingProviderSecrets(
    tenantId,
    "square"
  );

  const accessToken = clean(secrets?.accessToken);
  const refreshToken = clean(secrets?.refreshToken);
  const environment = getSquareEnvironment(connection.metadata);

  if (
    accessToken &&
    !shouldRefreshToken(secrets?.tokenExpiresAt ?? null)
  ) {
    return {
      ok: true,
      accessToken,
      environment,
      refreshed: false,
    };
  }

  if (!refreshToken) {
    return {
      ok: false,
      error: "SQUARE_REFRESH_TOKEN_MISSING",
      status: 401,
    };
  }

  return refreshSquareAccessToken({
    tenantId,
    environment,
    refreshToken,
  });
}

export async function getValidSquareAccessTokenForTenant(
  tenantIdInput: string
): Promise<GetValidSquareAccessTokenResult> {
  const tenantId = clean(tenantIdInput);

  if (!tenantId) {
    return {
      ok: false,
      error: "TENANT_ID_REQUIRED",
      status: 400,
    };
  }

  const existingPromise = refreshPromises.get(tenantId);

  if (existingPromise) {
    return existingPromise;
  }

  const promise = resolveValidSquareAccessToken(tenantId).finally(() => {
    refreshPromises.delete(tenantId);
  });

  refreshPromises.set(tenantId, promise);

  return promise;
}