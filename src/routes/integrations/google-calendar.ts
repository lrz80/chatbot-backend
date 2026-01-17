// src/routes/integrations/google-calendar.ts
import { Router, Request, Response } from "express";
import { authenticateUser } from "../../middleware/auth";
import pool from "../../lib/db";
import { canUseChannel } from "../../lib/features";
import fetch from "node-fetch"; // si estás en Node 18 y TS lo permite, puedes usar fetch global sin importar
import { encryptToken, decryptToken } from "../../services/googleCrypto";
import crypto from "crypto";


const router = Router();

function signState(payload: any) {
  const secret = process.env.GOOGLE_STATE_SECRET;
  if (!secret) throw new Error("GOOGLE_STATE_SECRET missing");

  const raw = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(raw).digest("base64url");
  return `${raw}.${sig}`;
}

function verifyState(state: string) {
  const secret = process.env.GOOGLE_STATE_SECRET;
  if (!secret) throw new Error("GOOGLE_STATE_SECRET missing");

  const [raw, sig] = state.split(".");
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("base64url");
  if (!raw || !sig || sig !== expected) throw new Error("invalid_state");

  return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
}


type GoogleTokens = { access_token: string; expires_in?: number; token_type?: string };

async function getRefreshTokenEnc(tenantId: string): Promise<string> {
  const { rows } = await pool.query(
    `
    SELECT refresh_token_enc
    FROM calendar_integrations
    WHERE tenant_id = $1
      AND provider = 'google'
      AND status = 'connected'
    LIMIT 1
    `,
    [tenantId]
  );

  const enc = rows[0]?.refresh_token_enc;
  if (!enc) throw new Error("google_not_connected");
  return enc;
}

export async function getGoogleAccessToken(tenantId: string): Promise<string> {
  const enc = await getRefreshTokenEnc(tenantId);
  const refresh_token = decryptToken(enc);
  if (!refresh_token) throw new Error("google_refresh_token_invalid");

  const client_id = process.env.GOOGLE_CLIENT_ID;
  const client_secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!client_id || !client_secret) throw new Error("google_oauth_not_configured");

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id,
      client_secret,
      refresh_token,
      grant_type: "refresh_token",
    }).toString(),
  });

  const json = (await resp.json()) as GoogleTokens & { error?: string; error_description?: string };
  if (!resp.ok || !json.access_token) {
    console.error("Google refresh failed:", resp.status, json);
    throw new Error("google_refresh_failed");
  }
  return json.access_token;
}

export async function googleFreeBusy(params: {
  tenantId: string;
  timeMin: string; // ISO
  timeMax: string; // ISO
  calendarId?: string; // default primary
}) {
  const accessToken = await getGoogleAccessToken(params.tenantId);
  const calendarId = params.calendarId || "primary";

  const resp = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      timeMin: params.timeMin,
      timeMax: params.timeMax,
      items: [{ id: calendarId }],
    }),
  });

  const json = await resp.json();
  if (!resp.ok) {
    console.error("Google freebusy failed:", json);
    throw new Error("google_freebusy_failed");
  }
  return json;
}

export async function googleCreateEvent(params: {
  tenantId: string;
  calendarId?: string; // default primary
  summary: string;
  description?: string;
  startISO: string;
  endISO: string;
  timeZone: string;
}) {
  const accessToken = await getGoogleAccessToken(params.tenantId);
  const calendarId = encodeURIComponent(params.calendarId || "primary");

  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: params.summary,
        description: params.description || "",
        start: { dateTime: params.startISO, timeZone: params.timeZone },
        end: { dateTime: params.endISO, timeZone: params.timeZone },
      }),
    }
  );

  const json = await resp.json();
  if (!resp.ok) {
    console.error("Google create event failed:", json);
    throw new Error("google_create_event_failed");
  }
  return json;
}

/**
 * GET /api/integrations/google-calendar/status
 * Devuelve estado de conexión (sin tokens) + gating del switch
 */
router.get("/status", authenticateUser, async (req, res) => {
  console.log("🧪 [GC STATUS] cookies token?", !!(req as any).cookies?.token);
  console.log("🧪 [GC STATUS] auth header?", !!req.headers?.authorization);
  try {
    const tenantId =
      (req as any).user?.tenant_id ??
      (res.locals as any)?.tenant_id ??
      (req as any).tenant_id ??
      (req as any).tenantId;

    if (!tenantId) return res.status(401).json({ error: "unauthorized" });

    // Gate por switch (google_calendar_enabled) + plan (plan=true en Paso 1) + pausas
    const gate = await canUseChannel(tenantId, "google_calendar");

    // Si está apagado, igual devolvemos si está conectado, pero marcamos enabled=false
    const { rows } = await pool.query(
      `
      SELECT connected_email, calendar_id, status, created_at, updated_at
      FROM calendar_integrations
      WHERE tenant_id = $1 AND provider = 'google'
      LIMIT 1
      `,
      [tenantId]
    );

    const r = rows[0];

    return res.json({
      enabled: gate.settings_enabled,         // el switch
      blocked: !gate.settings_enabled,        // para UI
      connected: !!r && r.status === "connected",
      connected_email: r?.connected_email || null,
      calendar_id: r?.calendar_id || "primary",
      integration_status: r?.status || "none",
      connected_at: r?.created_at || null,
      updated_at: r?.updated_at || null,
    });
  } catch (e) {
    console.error("google-calendar status error:", e);
    return res.status(500).json({ error: "internal" });
  }
});

/**
 * PUT /api/integrations/google-calendar/enabled
 * Body: { enabled: boolean }
 * Persiste el switch real: channel_settings.google_calendar_enabled
 */
router.put("/enabled", authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    if (!tenantId) return res.status(401).json({ error: "unauthorized" });

    const enabled = (req as any).body?.enabled;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be boolean" });
    }

    // Upsert por tenant: si no existe row, la crea
    await pool.query(
      `
      INSERT INTO channel_settings (tenant_id, google_calendar_enabled, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (tenant_id)
      DO UPDATE SET
        google_calendar_enabled = EXCLUDED.google_calendar_enabled,
        updated_at = NOW()
      `,
      [tenantId, enabled]
    );

    // devuelve status actualizado (incluye gate)
    const gate = await canUseChannel(tenantId, "google_calendar");
    return res.json({
      ok: true,
      enabled: gate.settings_enabled,
      blocked: !gate.settings_enabled,
      plan_enabled: gate.plan_enabled,
      paused_until: gate.paused_until,
    });
  } catch (e) {
    console.error("google-calendar enabled error:", e);
    return res.status(500).json({ error: "internal" });
  }
});

router.get("/connect", authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    if (!tenantId) return res.status(401).json({ error: "unauthorized" });

    const gate = await canUseChannel(tenantId, "google_calendar");
    console.log("🧪 [GC CONNECT] tenantId:", tenantId);
    console.log("🧪 [GC CONNECT] gate:", gate);

    //if (!gate.settings_enabled) {
    //  return res.status(403).json({ error: "google_calendar_disabled" });
    // }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URL;
    if (!clientId || !redirectUri) {
      return res.status(500).json({ error: "google_oauth_not_configured" });
    }

    // state firmado simple (tenantId + timestamp). Si prefieres JWT, lo hacemos luego.
    const state = signState({ tenantId, t: Date.now() });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/calendar",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });

    const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    return res.redirect(url);
  } catch (e) {
    console.error("google-calendar connect error:", e);
    return res.status(500).json({ error: "internal" });
  }
});

// 🔌 POST /api/integrations/google-calendar/disconnect
// Desconecta Google Calendar para el tenant (NO borra el switch de booking)
router.post("/disconnect", authenticateUser, async (req, res) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    if (!tenantId) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    // Marcar integración como desconectada (no borramos la fila para historial)
    await pool.query(
      `
      UPDATE calendar_integrations
      SET
        status = 'disconnected',
        refresh_token_enc = NULL,
        connected_email = NULL,
        updated_at = NOW()
      WHERE tenant_id = $1
        AND provider = 'google'
      `,
      [tenantId]
    );

    return res.json({
      ok: true,
      connected: false,
    });
  } catch (err) {
    console.error("❌ google-calendar disconnect error:", err);
    return res.status(500).json({
      ok: false,
      error: "internal_error",
    });
  }
});

router.get("/callback", async (req: Request, res: Response) => {
  try {
    const { code, state } = req.query as any;
    if (!code || !state) return res.status(400).send("Missing code/state");

    const decoded = verifyState(String(state));
    const tenantId = decoded?.tenantId;
    if (!tenantId) return res.status(400).send("Invalid state");

    const gate = await canUseChannel(tenantId, "google_calendar");
    if (!gate.settings_enabled) {
      return res.status(403).send("Google Calendar is disabled");
    }

    const clientId = process.env.GOOGLE_CLIENT_ID!;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URL!;

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(code),
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });

    const tokenJson: any = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error("Google token exchange failed:", tokenJson);
      return res.status(400).send("Token exchange failed");
    }

    const refreshToken = tokenJson.refresh_token;
    const accessToken = tokenJson.access_token;

    if (!refreshToken) {
      // Esto pasa si ya lo autorizó antes sin prompt=consent o Google no lo re-entrega
      return res.status(400).send("No refresh_token returned. Revoke access and try again.");
    }

    // Obtener email del usuario conectado (opcional pero útil)
    let connectedEmail: string | null = null;
    try {
      const infoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const infoJson: any = await infoRes.json();
      connectedEmail = infoJson?.email || null;
    } catch (_) {}

    const enc = encryptToken(String(refreshToken));

    await pool.query(
      `
      INSERT INTO calendar_integrations
        (tenant_id, provider, refresh_token_enc, connected_email, calendar_id, status, updated_at)
      VALUES
        ($1, 'google', $2, $3, 'primary', 'connected', now())
      ON CONFLICT (tenant_id, provider)
      DO UPDATE SET
        refresh_token_enc = EXCLUDED.refresh_token_enc,
        connected_email   = EXCLUDED.connected_email,
        calendar_id       = EXCLUDED.calendar_id,
        status            = 'connected',
        updated_at        = now()
      `,
      [tenantId, enc, connectedEmail]
    );

    // Redirige al dashboard donde muestras el status
    return res.redirect("https://www.aamy.ai/dashboard/appointments?google=connected");
  } catch (e) {
    console.error("google-calendar callback error:", e);
    return res.status(500).send("Internal error");
  }
});

export default router;
