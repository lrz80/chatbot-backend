// src/routes/integrations/square.ts
import { Router } from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import pool from "../../lib/db";
import { saveSquareConnection } from "../../lib/appointments/booking/providers/saveSquareConnection";
import { searchSquareAvailability } from "../../lib/integrations/square/searchSquareAvailability";
import { createSquareBooking } from "../../lib/integrations/square/createSquareBooking";
import { createSquareCustomer } from "../../lib/integrations/square/createSquareCustomer";
import { getSquareBookableServices } from "../../lib/integrations/square/getSquareBookableServices";
import { createSquareCustomerForTenant } from "../../lib/integrations/square/createSquareCustomerForTenant";
import { createSquareBookingFlowForTenant } from "../../lib/integrations/square/createSquareBookingFlowForTenant";
import { resolveSquareServiceMappingForTenant } from "../../lib/integrations/square/resolveSquareServiceMappingForTenant";
import { createSquareBookingFlowFromServiceNameForTenant } from "../../lib/integrations/square/createSquareBookingFlowFromServiceNameForTenant";
import { saveTenantExternalServiceMapping } from "../../lib/integrations/serviceMappings/saveTenantExternalServiceMapping";
import { getTenantExternalServiceMapping } from "../../lib/integrations/serviceMappings/getTenantExternalServiceMapping";
import { createSquareBookingFlowFromInternalServiceForTenant } from "../../lib/integrations/square/createSquareBookingFlowFromInternalServiceForTenant";
import { clearTenantBookingProviderCache } from "../../lib/appointments/booking/providers/resolveTenantBookingProvider";
import {
  getBookingProviderConnection,
  getBookingProviderSecrets,
} from "../../lib/appointments/booking/providers/providerConnections.repo";

const router = Router();

type SquareEnvironment = "sandbox" | "production";

type SquareOAuthStatePayload = {
  tenantId: string;
  environment: SquareEnvironment;
  nonce: string;
  ts: number;
};

type SquareTokenResponse = {
  access_token: string;
  token_type: string;
  expires_at?: string;
  merchant_id?: string;
  refresh_token?: string;
  short_lived?: boolean;
};

type SquareLocation = {
  id: string;
  status?: string;
  name?: string;
};

function getSquareConfig(environment: SquareEnvironment) {
  const isSandbox = environment === "sandbox";

  const appId = isSandbox
    ? process.env.SQUARE_SANDBOX_APPLICATION_ID?.trim()
    : (
        process.env.SQUARE_PRODUCTION_APPLICATION_ID ||
        process.env.SQUARE_APPLICATION_ID
      )?.trim();

  const appSecret = isSandbox
    ? process.env.SQUARE_SANDBOX_APPLICATION_SECRET?.trim()
    : (
        process.env.SQUARE_PRODUCTION_APPLICATION_SECRET ||
        process.env.SQUARE_APPLICATION_SECRET
      )?.trim();

  const redirectUri = isSandbox
    ? (
        process.env.SQUARE_SANDBOX_REDIRECT_URI ||
        process.env.SQUARE_REDIRECT_URI
      )?.trim()
    : (
        process.env.SQUARE_PRODUCTION_REDIRECT_URI ||
        process.env.SQUARE_REDIRECT_URI
      )?.trim();

  const baseUrl = isSandbox
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";

  const apiBaseUrl = baseUrl;

  if (!appId || !appSecret || !redirectUri) {
    throw new Error(
      `Missing Square OAuth config for environment=${environment}`
    );
  }

  return {
    appId,
    appSecret,
    redirectUri,
    baseUrl,
    apiBaseUrl,
  };
}

function getRequiredScopes(): string[] {
  return [
    "APPOINTMENTS_READ",
    "APPOINTMENTS_WRITE",
    "APPOINTMENTS_ALL_READ",
    "APPOINTMENTS_ALL_WRITE",
    "APPOINTMENTS_BUSINESS_SETTINGS_READ",
    "CUSTOMERS_READ",
    "CUSTOMERS_WRITE",
    "MERCHANT_PROFILE_READ",
    "ITEMS_READ",
  ];
}

function getStateSecret(): string {
  const secret = process.env.SQUARE_OAUTH_STATE_SECRET;
  if (!secret) {
    throw new Error("Missing SQUARE_OAUTH_STATE_SECRET");
  }
  return secret;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signStatePayload(payload: SquareOAuthStatePayload): string {
  const raw = JSON.stringify(payload);
  const encoded = base64UrlEncode(raw);

  const signature = crypto
    .createHmac("sha256", getStateSecret())
    .update(encoded)
    .digest("base64url");

  return `${encoded}.${signature}`;
}

function verifyAndParseState(state: string): SquareOAuthStatePayload | null {
  const rawState = String(state || "").trim();
  if (!rawState.includes(".")) return null;

  const [encoded, providedSignature] = rawState.split(".");
  if (!encoded || !providedSignature) return null;

  const expectedSignature = crypto
    .createHmac("sha256", getStateSecret())
    .update(encoded)
    .digest("base64url");

  const isValid = crypto.timingSafeEqual(
    Buffer.from(providedSignature),
    Buffer.from(expectedSignature)
  );

  if (!isValid) return null;

  const parsed = JSON.parse(base64UrlDecode(encoded)) as SquareOAuthStatePayload;

  if (
    !parsed ||
    typeof parsed.tenantId !== "string" ||
    (parsed.environment !== "sandbox" && parsed.environment !== "production") ||
    typeof parsed.nonce !== "string" ||
    typeof parsed.ts !== "number"
  ) {
    return null;
  }

  const ageMs = Date.now() - parsed.ts;
  const maxAgeMs = 10 * 60 * 1000; // 10 min
  if (ageMs < 0 || ageMs > maxAgeMs) {
    return null;
  }

  return parsed;
}

async function exchangeCodeForTokens(args: {
  code: string;
  environment: SquareEnvironment;
}) {
  const { code, environment } = args;
  const config = getSquareConfig(environment);

  const response = await fetch(`${config.apiBaseUrl}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Square-Version": "2026-03-18",
    },
    body: JSON.stringify({
      client_id: config.appId,
      client_secret: config.appSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri,
    }),
  });

  const data = (await response.json()) as SquareTokenResponse & {
    errors?: Array<{ category?: string; code?: string; detail?: string }>;
  };

  if (!response.ok || !data?.access_token) {
    throw new Error(
      `[SQUARE_TOKEN_EXCHANGE_FAILED] ${JSON.stringify(data?.errors || data)}`
    );
  }

  return data;
}

async function fetchSquareLocations(args: {
  accessToken: string;
  environment: SquareEnvironment;
}): Promise<SquareLocation[]> {
  const config = getSquareConfig(args.environment);

  const response = await fetch(`${config.apiBaseUrl}/v2/locations`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json",
      "Square-Version": "2026-03-18",
    },
  });

  const data = (await response.json()) as {
    locations?: SquareLocation[];
    errors?: Array<{ category?: string; code?: string; detail?: string }>;
  };

  if (!response.ok) {
    throw new Error(
      `[SQUARE_LOCATIONS_FAILED] ${JSON.stringify(data?.errors || data)}`
    );
  }

  return Array.isArray(data.locations) ? data.locations : [];
}

function ensureMinimumSquareAvailabilityEndAt(params: {
  startAt: string;
  endAt: string;
  minimumMinutes?: number;
}): string {
  const start = new Date(params.startAt);
  const end = new Date(params.endAt);
  const minimumMinutes = params.minimumMinutes ?? 60;

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return params.endAt;
  }

  const minimumEnd = new Date(start.getTime() + minimumMinutes * 60 * 1000);

  return end.getTime() < minimumEnd.getTime()
    ? minimumEnd.toISOString()
    : end.toISOString();
}

function pickDefaultLocationId(locations: SquareLocation[]): string {
  const active = locations.find((loc) => String(loc.status || "").toUpperCase() === "ACTIVE");
  const first = active || locations[0];

  return String(first?.id || "").trim();
}

function buildDashboardRedirectUrl(params: {
  status: "connected" | "error" | "cancelled";
  provider?: "square";
  reason?: string;
}): string {
  const dashboardBaseUrl = (
    process.env.APP_DASHBOARD_URL ||
    process.env.FRONTEND_URL ||
    "https://www.aamy.ai"
  ).replace(/\/$/, "");

  const url = new URL(`${dashboardBaseUrl}/dashboard/appointments`);

  url.searchParams.set("provider", params.provider || "square");
  url.searchParams.set("status", params.status);

  if (params.reason) {
    url.searchParams.set("reason", params.reason);
  }

  return url.toString();
}

/**
 * GET /api/integrations/square/oauth/start?tenantId=...&environment=sandbox|production
 */
router.get("/oauth/start", async (req, res) => {
  try {
    const tenantId = String(req.query?.tenantId || "").trim();
    const environment: SquareEnvironment =
      String(req.query?.environment || "production").trim().toLowerCase() === "sandbox"
        ? "sandbox"
        : "production";

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "TENANT_ID_REQUIRED",
      });
    }

    const config = getSquareConfig(environment);

    const state = signStatePayload({
      tenantId,
      environment,
      nonce: crypto.randomUUID(),
      ts: Date.now(),
    });

    const authUrl = new URL(`${config.baseUrl}/oauth2/authorize`);
    authUrl.searchParams.set("client_id", config.appId);
    authUrl.searchParams.set("scope", getRequiredScopes().join(" "));
    authUrl.searchParams.set("session", "false");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("redirect_uri", config.redirectUri);

    return res.redirect(authUrl.toString());
  } catch (error) {
    console.error("[SQUARE_OAUTH_START] unexpected error", error);
    return res.status(500).json({
      ok: false,
      error: "SQUARE_OAUTH_START_FAILED",
    });
  }
});

/**
 * GET /api/integrations/square/oauth/callback?code=...&state=...
 */
router.get("/oauth/callback", async (req, res) => {
  try {
    const code = String(req.query?.code || "").trim();
    const state = String(req.query?.state || "").trim();
    const error = String(req.query?.error || "").trim();
    const errorDescription = String(req.query?.error_description || "").trim();

    if (error) {
      console.error("[SQUARE_OAUTH_CALLBACK] oauth error", {
        error,
        errorDescription,
      });

      return res.redirect(
        buildDashboardRedirectUrl({
          status: "cancelled",
          reason: error || "oauth_cancelled",
        })
      );
    }

    if (!code || !state) {
      return res.redirect(
        buildDashboardRedirectUrl({
          status: "error",
          reason: "missing_oauth_parameters",
        })
      );
    }

    const parsedState = verifyAndParseState(state);
    if (!parsedState) {
      return res.redirect(
        buildDashboardRedirectUrl({
          status: "error",
          reason: "invalid_or_expired_state",
        })
      );
    }

    const { tenantId, environment } = parsedState;

    const tokenData = await exchangeCodeForTokens({
      code,
      environment,
    });

    const locations = await fetchSquareLocations({
      accessToken: tokenData.access_token,
      environment,
    });

    const locationId = pickDefaultLocationId(locations);

    const result = await saveSquareConnection({
      tenantId,
      accessToken: tokenData.access_token,
      refreshToken: String(tokenData.refresh_token || "").trim(),
      merchantId: String(tokenData.merchant_id || "").trim(),
      locationId,
      expiresAt: String(tokenData.expires_at || "").trim() || null,
      environment,
    });

    if (!result.ok) {
      console.error("[SQUARE_OAUTH_CALLBACK] save failed", result);

      return res.redirect(
        buildDashboardRedirectUrl({
          status: "error",
          reason: "save_connection_failed",
        })
      );
    }

    return res.redirect(
      buildDashboardRedirectUrl({
        status: "connected",
      })
    );
  } catch (error) {
    console.error("[SQUARE_OAUTH_CALLBACK] unexpected error", error);
    return res.redirect(
      buildDashboardRedirectUrl({
        status: "error",
        reason: "square_connection_failed",
      })
    );
  }
});

/**
 * POST /api/integrations/square/disconnect
 */
router.post("/disconnect", async (req, res) => {
  try {
    const tenantId = String(req.body?.tenantId || "").trim();

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "TENANT_ID_REQUIRED",
      });
    }

    await pool.query(
      `
      UPDATE booking_provider_connections
      SET
        status = 'inactive',
        access_token = NULL,
        refresh_token = NULL,
        token_expires_at = NULL,
        updated_at = NOW()
      WHERE tenant_id = $1
        AND provider = 'square'
      `,
      [tenantId]
    );

    clearTenantBookingProviderCache(tenantId);

    return res.status(200).json({
      ok: true,
    });
  } catch (error) {
    console.error("[SQUARE_DISCONNECT] unexpected error", error);
    return res.status(500).json({
      ok: false,
      error: "SQUARE_DISCONNECT_FAILED",
    });
  }
});

router.get("/sandbox/locations", async (req, res) => {
  try {
    const accessToken = String(req.query?.accessToken || "").trim();

    if (!accessToken) {
      return res.status(400).json({
        ok: false,
        error: "ACCESS_TOKEN_REQUIRED",
      });
    }

    const response = await fetch("https://connect.squareupsandbox.com/v2/locations", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Square-Version": "2026-03-18",
      },
    });

    const data = await response.json();

    return res.status(response.ok ? 200 : response.status).json({
      ok: response.ok,
      data,
    });
  } catch (error) {
    console.error("[SQUARE_SANDBOX_LOCATIONS] unexpected error", error);
    return res.status(500).json({
      ok: false,
      error: "SQUARE_SANDBOX_LOCATIONS_FAILED",
    });
  }
});

router.get("/sandbox/team-members", async (req, res) => {
  try {
    const accessToken = String(req.query?.accessToken || "").trim();

    if (!accessToken) {
      return res.status(400).json({
        ok: false,
        error: "ACCESS_TOKEN_REQUIRED",
      });
    }

    const response = await fetch(
      "https://connect.squareupsandbox.com/v2/bookings/team-member-booking-profiles",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "Square-Version": "2026-03-18",
        },
      }
    );

    const data = await response.json();

    return res.status(response.ok ? 200 : response.status).json({
      ok: response.ok,
      data,
    });
  } catch (error) {
    console.error("[SQUARE_SANDBOX_TEAM_MEMBERS] unexpected error", error);
    return res.status(500).json({
      ok: false,
      error: "SQUARE_SANDBOX_TEAM_MEMBERS_FAILED",
    });
  }
});

router.get("/sandbox/services", async (req, res) => {
  try {
    const accessToken = String(req.query?.accessToken || "").trim();

    const result = await getSquareBookableServices({
      accessToken,
      environment: "sandbox",
    });

    if (!result.ok) {
      return res.status(result.status || 500).json(result);
    }

    return res.status(200).json({
      ok: true,
      data: {
        services: result.services,
        errors: [],
      },
    });
  } catch (error) {
    console.error("[SQUARE_SANDBOX_SERVICES] unexpected error", error);
    return res.status(500).json({
      ok: false,
      error: "SQUARE_SANDBOX_SERVICES_FAILED",
    });
  }
});

router.post("/sandbox/customers", async (req, res) => {
  try {
    const accessToken = String(req.body?.accessToken || "").trim();
    const givenName = String(req.body?.givenName || "").trim();
    const familyName = String(req.body?.familyName || "").trim();
    const email = String(req.body?.email || "").trim();
    const phoneNumber = String(req.body?.phoneNumber || "").trim();

    const result = await createSquareCustomer({
      accessToken,
      environment: "sandbox",
      givenName,
      familyName,
      email,
      phoneNumber,
    });

    if (!result.ok) {
      return res.status(result.status || 500).json(result);
    }

    return res.status(200).json({
      ok: true,
      data: {
        customer: result.customer,
        errors: [],
      },
    });
  } catch (error) {
    console.error("[SQUARE_SANDBOX_CREATE_CUSTOMER] unexpected error", error);
    return res.status(500).json({
      ok: false,
      error: "SQUARE_SANDBOX_CREATE_CUSTOMER_FAILED",
    });
  }
});

router.post("/sandbox/bookings", async (req, res) => {
  try {
    const accessToken = String(req.body?.accessToken || "").trim();
    const customerId = String(req.body?.customerId || "").trim();
    const startAt = String(req.body?.startAt || "").trim();
    const locationId = String(req.body?.locationId || "").trim();
    const teamMemberId = String(req.body?.teamMemberId || "").trim();
    const serviceVariationId = String(req.body?.serviceVariationId || "").trim();

    const serviceVariationVersionRaw = req.body?.serviceVariationVersion;
    const durationMinutesRaw = req.body?.durationMinutes;

    const serviceVariationVersion =
      typeof serviceVariationVersionRaw === "string" || typeof serviceVariationVersionRaw === "number"
        ? Number(serviceVariationVersionRaw)
        : NaN;

    const durationMinutes =
      typeof durationMinutesRaw === "string" || typeof durationMinutesRaw === "number"
        ? Number(durationMinutesRaw)
        : NaN;

    const result = await createSquareBooking({
      accessToken,
      environment: "sandbox",
      customerId,
      startAt,
      locationId,
      teamMemberId,
      serviceVariationId,
      serviceVariationVersion,
      durationMinutes,
    });

    if (!result.ok) {
      return res.status(result.status || 500).json(result);
    }

    return res.status(200).json({
      ok: true,
      data: {
        booking: result.booking,
        errors: [],
      },
    });
  } catch (error) {
    console.error("[SQUARE_SANDBOX_CREATE_BOOKING] unexpected error", error);
    return res.status(500).json({
      ok: false,
      error: "SQUARE_SANDBOX_CREATE_BOOKING_FAILED",
    });
  }
});

router.post("/sandbox/availability", async (req, res) => {
  try {
    const accessToken = String(req.body?.accessToken || "").trim();
    const locationId = String(req.body?.locationId || "").trim();
    const serviceVariationId = String(req.body?.serviceVariationId || "").trim();
    const startAt = String(req.body?.startAt || "").trim();
    const endAt = String(req.body?.endAt || "").trim();

    const result = await searchSquareAvailability({
      accessToken,
      environment: "sandbox",
      locationId,
      serviceVariationId,
      startAt,
      endAt,
    });

    if (!result.ok) {
      return res.status(result.status || 500).json(result);
    }

    return res.status(200).json({
      ok: true,
      data: {
        availabilities: result.availabilities,
        errors: [],
      },
    });
  } catch (error) {
    console.error("[SQUARE_SANDBOX_AVAILABILITY] unexpected error", error);
    return res.status(500).json({
      ok: false,
      error: "SQUARE_SANDBOX_AVAILABILITY_FAILED",
    });
  }
});

router.get("/status", async (req, res) => {
  try {
    const tenantId = String(req.query?.tenantId || "").trim();

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "TENANT_ID_REQUIRED",
      });
    }

    const connection = await getBookingProviderConnection(tenantId, "square");

    if (!connection) {
      return res.status(200).json({
        ok: true,
        data: {
          connected: false,
          tenantId,
          provider: "square",
          merchantId: null,
          locationId: null,
          environment: null,
          expiresAt: null,
          status: "inactive",
        },
      });
    }

    return res.status(200).json({
      ok: true,
      data: {
        connected: connection.status === "active",
        tenantId: connection.tenant_id,
        provider: "square",
        merchantId: connection.external_account_id,
        locationId: connection.external_location_id,
        environment:
          typeof connection.metadata?.environment === "string"
            ? connection.metadata.environment
            : null,
        expiresAt: connection.token_expires_at,
        status: connection.status,
        locationName:
          typeof connection.metadata?.location_name === "string"
            ? connection.metadata.location_name
            : null,
      },
    });
  } catch (error) {
    console.error("[SQUARE_STATUS] unexpected error", error);
    return res.status(500).json({
      ok: false,
      error: "SQUARE_STATUS_FAILED",
    });
  }
});

router.post("/tenant/customer", async (req, res) => {
  try {
    const tenantId = String(req.body?.tenantId || "").trim();
    const givenName = String(req.body?.givenName || "").trim();
    const familyName = String(req.body?.familyName || "").trim();
    const email = String(req.body?.email || "").trim();
    const phoneNumber = String(req.body?.phoneNumber || "").trim();

    const result = await createSquareCustomerForTenant({
      tenantId,
      givenName,
      familyName,
      email,
      phoneNumber,
    });

    if (!result.ok) {
      return res.status(result.status || 500).json(result);
    }

    return res.status(200).json({
      ok: true,
      data: {
        customer: result.customer,
        errors: [],
      },
    });
  } catch (error) {
    console.error("[SQUARE_TENANT_CREATE_CUSTOMER] unexpected error", error);
    return res.status(500).json({
      ok: false,
      error: "SQUARE_TENANT_CREATE_CUSTOMER_FAILED",
    });
  }
});

router.post("/tenant/booking-flow", async (req, res) => {
  try {
    const tenantId = String(req.body?.tenantId || "").trim();
    const serviceVariationId = String(req.body?.serviceVariationId || "").trim();
    const startAt = String(req.body?.startAt || "").trim();
    const endAt = String(req.body?.endAt || "").trim();
    const locationId = String(req.body?.locationId || "").trim() || null;

    const givenName = String(req.body?.customer?.givenName || "").trim();
    const familyName = String(req.body?.customer?.familyName || "").trim();
    const email = String(req.body?.customer?.email || "").trim();
    const phoneNumber = String(req.body?.customer?.phoneNumber || "").trim();

    const result = await createSquareBookingFlowForTenant({
      tenantId,
      serviceVariationId,
      startAt,
      endAt,
      locationId,
      customer: {
        givenName,
        familyName,
        email,
        phoneNumber,
      },
    });

    if (!result.ok) {
      return res.status(result.status || 500).json(result);
    }

    return res.status(200).json({
      ok: true,
      data: {
        customerId: result.customerId,
        availability: result.availability,
        booking: result.booking,
        errors: [],
      },
    });
  } catch (error) {
    console.error("[SQUARE_TENANT_BOOKING_FLOW] unexpected error", error);
    return res.status(500).json({
      ok: false,
      error: "SQUARE_TENANT_BOOKING_FLOW_FAILED",
    });
  }
});

router.get("/tenant/services", async (req, res) => {
  try {
    const tenantId = String(req.query?.tenantId || "").trim();

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "TENANT_ID_REQUIRED",
      });
    }

    const connection = await getBookingProviderConnection(tenantId, "square");

    if (!connection || connection.status !== "active") {
      return res.status(404).json({
        ok: false,
        error: "SQUARE_CONNECTION_NOT_FOUND",
      });
    }

    const secrets = await getBookingProviderSecrets(tenantId, "square");
    const accessToken = String(secrets?.accessToken || "").trim();

    const environment =
      connection.metadata?.environment === "sandbox" ? "sandbox" : "production";

    if (!accessToken) {
      return res.status(400).json({
        ok: false,
        error: "SQUARE_ACCESS_TOKEN_MISSING",
      });
    }

    const result = await getSquareBookableServices({
      accessToken,
      environment,
    });

    if (!result.ok) {
      return res.status(result.status || 500).json(result);
    }

    return res.status(200).json({
      ok: true,
      data: {
        services: result.services,
        errors: [],
      },
    });
  } catch (error) {
    console.error("[SQUARE_TENANT_SERVICES] unexpected error", error);

    return res.status(500).json({
      ok: false,
      error: "SQUARE_TENANT_SERVICES_FAILED",
    });
  }
});

router.get("/tenant/team-members", async (req, res) => {
  try {
    const tenantId = String(req.query?.tenantId || "").trim();

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "TENANT_ID_REQUIRED",
      });
    }

    const connection = await getBookingProviderConnection(tenantId, "square");

    if (!connection || connection.status !== "active") {
      return res.status(404).json({
        ok: false,
        error: "SQUARE_CONNECTION_NOT_FOUND",
      });
    }

    const secrets = await getBookingProviderSecrets(tenantId, "square");
    const accessToken = String(secrets?.accessToken || "").trim();

    const environment =
      connection.metadata?.environment === "sandbox" ? "sandbox" : "production";

    if (!accessToken) {
      return res.status(400).json({
        ok: false,
        error: "SQUARE_ACCESS_TOKEN_MISSING",
      });
    }

    const baseUrl =
      environment === "sandbox"
        ? "https://connect.squareupsandbox.com"
        : "https://connect.squareup.com";

    const response = await fetch(
      `${baseUrl}/v2/bookings/team-member-booking-profiles`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "Square-Version": process.env.SQUARE_API_VERSION?.trim() || "2026-03-18",
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: "SQUARE_TEAM_MEMBERS_FAILED",
        details: data,
      });
    }

    return res.status(200).json({
      ok: true,
      data,
    });
  } catch (error) {
    console.error("[SQUARE_TENANT_TEAM_MEMBERS] unexpected error", error);

    return res.status(500).json({
      ok: false,
      error: "SQUARE_TENANT_TEAM_MEMBERS_FAILED",
    });
  }
});

router.get("/tenant/resolve-service", async (req, res) => {
  try {
    const tenantId = String(req.query?.tenantId || "").trim();
    const serviceVariationId = String(req.query?.serviceVariationId || "").trim();
    const serviceName = String(req.query?.serviceName || "").trim();

    const result = await resolveSquareServiceMappingForTenant({
      tenantId,
      serviceVariationId,
      serviceName,
    });

    if (!result.ok) {
      return res.status(result.status || 500).json(result);
    }

    return res.status(200).json({
      ok: true,
      data: {
        service: result.service,
        errors: [],
      },
    });
  } catch (error) {
    console.error("[SQUARE_TENANT_RESOLVE_SERVICE] unexpected error", error);
    return res.status(500).json({
      ok: false,
      error: "SQUARE_TENANT_RESOLVE_SERVICE_FAILED",
    });
  }
});

router.post("/tenant/booking-flow-by-service-name", async (req, res) => {
  try {
    const tenantId = String(req.body?.tenantId || "").trim();
    const serviceName = String(req.body?.serviceName || "").trim();
    const startAt = String(req.body?.startAt || "").trim();
    const endAt = String(req.body?.endAt || "").trim();
    const locationId = String(req.body?.locationId || "").trim() || null;

    const givenName = String(req.body?.customer?.givenName || "").trim();
    const familyName = String(req.body?.customer?.familyName || "").trim();
    const email = String(req.body?.customer?.email || "").trim();
    const phoneNumber = String(req.body?.customer?.phoneNumber || "").trim();

    const result = await createSquareBookingFlowFromServiceNameForTenant({
      tenantId,
      serviceName,
      startAt,
      endAt,
      locationId,
      customer: {
        givenName,
        familyName,
        email,
        phoneNumber,
      },
    });

    if (!result.ok) {
      return res.status(result.status || 500).json(result);
    }

    return res.status(200).json({
      ok: true,
      data: {
        customerId: result.customerId,
        availability: result.availability,
        booking: result.booking,
        errors: [],
      },
    });
  } catch (error) {
    console.error("[SQUARE_TENANT_BOOKING_FLOW_BY_SERVICE_NAME] unexpected error", error);
    return res.status(500).json({
      ok: false,
      error: "SQUARE_TENANT_BOOKING_FLOW_BY_SERVICE_NAME_FAILED",
    });
  }
});

router.post("/tenant/service-mappings/save", async (req, res) => {
  try {
    const tenantId = String(req.body?.tenantId || "").trim();
    const internalServiceKey = String(req.body?.internalServiceKey || "").trim();
    const externalServiceId = String(req.body?.externalServiceId || "").trim();

    const externalServiceVersionRaw = req.body?.externalServiceVersion;
    const externalLocationId = String(req.body?.externalLocationId || "").trim() || null;
    const externalMetadata =
      req.body?.externalMetadata && typeof req.body.externalMetadata === "object"
        ? req.body.externalMetadata
        : {};
    const isActive = req.body?.isActive !== false;

    const externalServiceVersion =
      externalServiceVersionRaw == null ? null : Number(externalServiceVersionRaw);

    const result = await saveTenantExternalServiceMapping({
      tenantId,
      provider: "square",
      internalServiceKey,
      externalServiceId,
      externalServiceVersion,
      externalLocationId,
      externalMetadata,
      isActive,
    });

    if (!result.ok) {
      return res.status(result.status || 500).json(result);
    }

    return res.status(200).json({
      ok: true,
      data: {
        mapping: result.mapping,
        errors: [],
      },
    });
  } catch (error) {
    console.error("[SQUARE_TENANT_SERVICE_MAPPING_SAVE] unexpected error", error);
    return res.status(500).json({
      ok: false,
      error: "SQUARE_TENANT_SERVICE_MAPPING_SAVE_FAILED",
    });
  }
});

router.get("/tenant/service-mappings/get", async (req, res) => {
  try {
    const tenantId = String(req.query?.tenantId || "").trim();
    const internalServiceKey = String(req.query?.internalServiceKey || "").trim();

    const result = await getTenantExternalServiceMapping({
      tenantId,
      provider: "square",
      internalServiceKey,
    });

    if (!result.ok) {
      return res.status(result.status || 500).json(result);
    }

    return res.status(200).json({
      ok: true,
      data: {
        mapping: result.mapping,
        errors: [],
      },
    });
  } catch (error) {
    console.error("[SQUARE_TENANT_SERVICE_MAPPING_GET] unexpected error", error);
    return res.status(500).json({
      ok: false,
      error: "SQUARE_TENANT_SERVICE_MAPPING_GET_FAILED",
    });
  }
});

router.post("/tenant/booking-flow-by-internal-service", async (req, res) => {
  try {
    const tenantId = String(req.body?.tenantId || "").trim();
    const internalServiceKey = String(req.body?.internalServiceKey || "").trim();
    const startAt = String(req.body?.startAt || "").trim();
    const endAt = String(req.body?.endAt || "").trim();

    const givenName = String(req.body?.customer?.givenName || "").trim();
    const familyName = String(req.body?.customer?.familyName || "").trim();
    const email = String(req.body?.customer?.email || "").trim();
    const phoneNumber = String(req.body?.customer?.phoneNumber || "").trim();

    const availabilityEndAt = ensureMinimumSquareAvailabilityEndAt({
      startAt,
      endAt,
      minimumMinutes: 60,
    });

    const result = await createSquareBookingFlowFromInternalServiceForTenant({
      tenantId,
      internalServiceKey,
      startAt,
      endAt: availabilityEndAt,
      customer: {
        givenName,
        familyName,
        email,
        phoneNumber,
      },
    });

    if (!result.ok) {
      return res.status(result.status || 500).json(result);
    }

    return res.status(200).json({
      ok: true,
      data: {
        booking: result.booking,
        availability: result.availability,
        customerId: result.customerId,
        errors: [],
      },
    });
  } catch (error) {
    console.error("[SQUARE_TENANT_BOOKING_FLOW_BY_INTERNAL_SERVICE] unexpected error", error);
    return res.status(500).json({
      ok: false,
      error: "SQUARE_TENANT_BOOKING_FLOW_BY_INTERNAL_SERVICE_FAILED",
    });
  }
});

export default router;