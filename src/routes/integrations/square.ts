// src/routes/integrations/square.ts
import { Router } from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import pool from "../../lib/db";
import { saveSquareConnection } from "../../lib/appointments/booking/providers/saveSquareConnection";

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
    ? process.env.SQUARE_SANDBOX_APPLICATION_ID
    : process.env.SQUARE_APPLICATION_ID;

  const appSecret = isSandbox
    ? process.env.SQUARE_SANDBOX_APPLICATION_SECRET
    : process.env.SQUARE_APPLICATION_SECRET;

  const redirectUri = isSandbox
    ? process.env.SQUARE_SANDBOX_REDIRECT_URI
    : process.env.SQUARE_REDIRECT_URI;

  const baseUrl = isSandbox
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";

  const apiBaseUrl = isSandbox
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";

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
    "APPOINTMENTS_ALL_READ",
    "APPOINTMENTS_ALL_WRITE",
    "APPOINTMENTS_BUSINESS_SETTINGS_READ",
    "CUSTOMERS_READ",
    "CUSTOMERS_WRITE",
    "MERCHANT_PROFILE_READ",
    "EMPLOYEES_READ",
    "TIMECARDS_READ",
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

function pickDefaultLocationId(locations: SquareLocation[]): string {
  const active = locations.find((loc) => String(loc.status || "").toUpperCase() === "ACTIVE");
  const first = active || locations[0];

  return String(first?.id || "").trim();
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

      return res.status(400).send("Square authorization was canceled or failed.");
    }

    if (!code || !state) {
      return res.status(400).send("Missing Square OAuth parameters.");
    }

    const parsedState = verifyAndParseState(state);
    if (!parsedState) {
      return res.status(400).send("Invalid or expired OAuth state.");
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
      return res.status(result.status || 500).send("Could not save Square connection.");
    }

    const dashboardUrl = `${process.env.APP_DASHBOARD_URL || "https://aamy.ai"}/dashboard/integrations?provider=square&status=connected`;

    return res.redirect(dashboardUrl);
  } catch (error) {
    console.error("[SQUARE_OAUTH_CALLBACK] unexpected error", error);
    return res.status(500).send("Square connection failed.");
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
      UPDATE tenants
      SET
        square_access_token = NULL,
        square_refresh_token = NULL,
        square_merchant_id = NULL,
        square_location_id = NULL,
        square_token_expires_at = NULL,
        square_environment = NULL,
        square_connected_at = NULL,
        square_status = 'disconnected',
        updated_at = NOW()
      WHERE id = $1
      `,
      [tenantId]
    );

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

    if (!accessToken) {
      return res.status(400).json({
        ok: false,
        error: "ACCESS_TOKEN_REQUIRED",
      });
    }

    const response = await fetch(
      "https://connect.squareupsandbox.com/v2/catalog/search",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "Square-Version": "2026-03-18",
        },
        body: JSON.stringify({
          object_types: ["ITEM", "ITEM_VARIATION"],
          include_related_objects: true,
        }),
      }
    );

    const data = await response.json();

    return res.status(response.ok ? 200 : response.status).json({
      ok: response.ok,
      data,
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

    if (!accessToken) {
      return res.status(400).json({ ok: false, error: "ACCESS_TOKEN_REQUIRED" });
    }

    const response = await fetch(
      "https://connect.squareupsandbox.com/v2/customers",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "Square-Version": "2026-01-22",
        },
        body: JSON.stringify({
          given_name: givenName || "Test",
          family_name: familyName || "Customer",
          email_address: email || undefined,
          phone_number: phoneNumber || undefined,
        }),
      }
    );

    const data = await response.json();

    return res.status(response.ok ? 200 : response.status).json({
      ok: response.ok,
      data,
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

    if (
      !accessToken ||
      !customerId ||
      !startAt ||
      !locationId ||
      !teamMemberId ||
      !serviceVariationId ||
      !Number.isFinite(serviceVariationVersion) ||
      !Number.isFinite(durationMinutes)
    ) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_REQUIRED_FIELDS",
      });
    }

    const response = await fetch(
      "https://connect.squareupsandbox.com/v2/bookings",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "Square-Version": "2026-01-22",
        },
        body: JSON.stringify({
          idempotency_key: crypto.randomUUID(),
          booking: {
            customer_id: customerId,
            start_at: startAt,
            location_id: locationId,
            appointment_segments: [
              {
                duration_minutes: durationMinutes,
                team_member_id: teamMemberId,
                service_variation_id: serviceVariationId,
                service_variation_version: serviceVariationVersion,
              },
            ],
          },
        }),
      }
    );

    const data = await response.json();

    return res.status(response.ok ? 200 : response.status).json({
      ok: response.ok,
      data,
    });
  } catch (error) {
    console.error("[SQUARE_SANDBOX_CREATE_BOOKING] unexpected error", error);
    return res.status(500).json({
      ok: false,
      error: "SQUARE_SANDBOX_CREATE_BOOKING_FAILED",
    });
  }
});

export default router;