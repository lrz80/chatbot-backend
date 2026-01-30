// src/routes/integrations/google-calendar.ts
import { Router, Request, Response } from "express";
import { authenticateUser } from "../../middleware/auth";
import pool from "../../lib/db";
import { canUseChannel } from "../../lib/features";
import fetch from "node-fetch"; // si estás en Node 18 y TS lo permite, puedes usar fetch global sin importar
import { encryptToken, decryptToken } from "../../services/googleCrypto";
import crypto from "crypto";
import { googleFreeBusy, googleCreateEvent } from "../../services/googleCalendar";

const router = Router();

function getTenantId(req: Request, res: Response) {
  return (
    (req as any).user?.tenant_id ??
    (res.locals as any)?.tenant_id ??
    (req as any).tenant_id ??
    (req as any).tenantId
  );
}

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
      scope: [
        "https://www.googleapis.com/auth/calendar",
        "openid",
        "email",
        "profile",
      ].join(" "),
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
        status = 'revoked',
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

async function getExistingRefreshEnc(tenantId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `
    SELECT refresh_token_enc
    FROM calendar_integrations
    WHERE tenant_id = $1 AND provider = 'google'
    LIMIT 1
    `,
    [tenantId]
  );
  return rows[0]?.refresh_token_enc || null;
}

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

    const refreshToken = tokenJson.refresh_token; // puede venir undefined
    const accessToken = tokenJson.access_token;

    let refreshEncToStore: string | null = null;

    // ✅ 1) Buscar el calendarId real del "primary"
    let calendarIdReal: string = "primary";

    try {
      const calListRes = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const calListJson: any = await calListRes.json();

      const primary = Array.isArray(calListJson?.items)
        ? calListJson.items.find((c: any) => c?.primary === true)
        : null;

      if (primary?.id) calendarIdReal = String(primary.id);
    } catch (e) {
      console.log("⚠️ Could not fetch calendarList, using primary fallback");
    }

    if (refreshToken) {
      refreshEncToStore = encryptToken(String(refreshToken));
    } else {
      // ✅ Google no siempre re-entrega refresh_token.
      // Si ya tenemos uno guardado, lo conservamos.
      refreshEncToStore = await getExistingRefreshEnc(tenantId);

      // Si no hay uno previo, entonces sí no podemos seguir
      if (!refreshEncToStore) {
        return res
          .status(400)
          .send("No refresh_token returned and no existing token on file. Revoke access and try again.");
      }
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

    await pool.query(
      `
      INSERT INTO calendar_integrations
        (tenant_id, provider, refresh_token_enc, connected_email, calendar_id, status, updated_at)
      VALUES
        ($1, 'google', $2, $3, $4, 'connected', now())
      ON CONFLICT (tenant_id, provider)
      DO UPDATE SET
        refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, calendar_integrations.refresh_token_enc),
        connected_email   = EXCLUDED.connected_email,
        calendar_id       = EXCLUDED.calendar_id,
        status            = 'connected',
        updated_at        = now()
      `,
      [tenantId, refreshEncToStore, connectedEmail, calendarIdReal]
    );

    // Redirige al dashboard donde muestras el status
    return res.redirect("https://www.aamy.ai/dashboard/appointments?google=connected");
  } catch (e) {
    console.error("google-calendar callback error:", e);
    return res.status(500).send("Internal error");
  }
});

// POST /api/integrations/google-calendar/availability
router.post("/availability", authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req, res);
    if (!tenantId) return res.status(401).json({ error: "unauthorized" });

    const gate = await canUseChannel(tenantId, "google_calendar");
    if (!gate.settings_enabled) return res.status(403).json({ error: "google_calendar_disabled" });

    const { timeMin, timeMax, calendarId } = req.body || {};
    if (!timeMin || !timeMax) return res.status(400).json({ error: "missing_time_range" });

    const fb = await googleFreeBusy({ tenantId, timeMin, timeMax, calendarId: calendarId || "primary" });
    const busy = fb?.calendars?.[calendarId || "primary"]?.busy || [];

    return res.json({ ok: true, busy, is_free: busy.length === 0 });
  } catch (e: any) {
    const msg = String(e?.message || "");
    if (msg === "google_not_connected") return res.status(409).json({ error: "google_not_connected" });
    return res.status(500).json({ error: "internal" });
  }
});

// POST /api/integrations/google-calendar/book
router.post("/book", authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req, res);
    if (!tenantId) return res.status(401).json({ error: "unauthorized" });

    const gate = await canUseChannel(tenantId, "google_calendar");
    if (!gate.settings_enabled) return res.status(403).json({ error: "google_calendar_disabled" });

    const { summary, description, startISO, endISO, timeZone, calendarId } = req.body || {};
    if (!summary || !startISO || !endISO || !timeZone) {
      return res.status(400).json({ error: "missing_fields" });
    }

    // (opcional) validación: evitar doble booking haciendo freebusy del slot exacto
    const fb = await googleFreeBusy({
      tenantId,
      timeMin: startISO,
      timeMax: endISO,
      calendarId: calendarId || "primary",
    });
    const busy = fb?.calendars?.[calendarId || "primary"]?.busy || [];
    if (busy.length > 0) return res.status(409).json({ error: "slot_busy", busy });

    const event = await googleCreateEvent({
      tenantId,
      calendarId: calendarId || "primary",
      summary,
      description,
      startISO,
      endISO,
      timeZone,
    });

    // (opcional) persistir en tu DB appointments si ya tienes tabla
    // await pool.query(`INSERT INTO appointments (...) VALUES (...)`, [...]);

    return res.json({ ok: true, event_id: event?.id, htmlLink: event?.htmlLink || null });
  } catch (e: any) {
    const msg = String(e?.message || "");
    if (msg === "google_not_connected") return res.status(409).json({ error: "google_not_connected" });
    return res.status(500).json({ error: "internal" });
  }
});

export default router;
