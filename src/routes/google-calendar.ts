//src/routes/google-calendar.ts
import { Router } from "express";
import { authenticateUser } from "../middleware/auth";
import pool from "../lib/db";
import crypto from "crypto";
import { encryptToken } from "../services/googleCrypto";

const router = Router();

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const REDIRECT_URL = process.env.GOOGLE_OAUTH_REDIRECT_URL!;

function mustEnv() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URL) {
    throw new Error("Missing GOOGLE_OAUTH_* env vars");
  }
}

// 1) Estado actual
router.get("/status", authenticateUser, async (req: any, res) => {
  const tenantId = req.user?.tenant_id;

  const { rows } = await pool.query(
    `SELECT connected, calendar_id, refresh_token, enabled
       FROM google_calendar_integrations
      WHERE tenant_id = $1
      LIMIT 1`,
    [tenantId]
  );

  const row = rows[0];

  const connected = !!row && row.connected === true && !!row.refresh_token;

  return res.json({
    ok: true,
    connected,
    enabled: row?.enabled ?? false,
    calendar_id: row?.calendar_id || "primary",
  });
});

// 1.5) Prender / apagar agendamiento (NO es conectar OAuth)
router.put("/enabled", authenticateUser, async (req: any, res) => {
  const tenantId = req.user?.tenant_id;
  const enabled = req.body?.enabled;

  if (typeof enabled !== "boolean") {
    return res.status(400).json({ ok: false, error: "enabled must be boolean" });
  }

  const { rows } = await pool.query(
    `INSERT INTO google_calendar_integrations (tenant_id, enabled, connected, calendar_id)
     VALUES ($1, $2, FALSE, 'primary')
     ON CONFLICT (tenant_id)
     DO UPDATE SET enabled = EXCLUDED.enabled
     RETURNING tenant_id, enabled, connected, calendar_id`,
    [tenantId, enabled]
  );

  return res.json({ ok: true, ...rows[0] });
});

// 2) Iniciar OAuth (devuelve authUrl)
router.post("/oauth/start", authenticateUser, async (req: any, res) => {
  mustEnv();
  const tenantId = req.user?.tenant_id;

  // state firmado para evitar CSRF y saber tenant
  const nonce = crypto.randomBytes(16).toString("hex");
  const state = Buffer.from(JSON.stringify({ tenantId, nonce })).toString("base64url");

  // guarda nonce temporal (simple: en DB)
  await pool.query(
    `INSERT INTO google_calendar_integrations (tenant_id, connected, calendar_id, updated_at)
     VALUES ($1, FALSE, 'primary', NOW())
     ON CONFLICT (tenant_id) DO UPDATE SET updated_at = NOW()`,
    [tenantId]
  );

  const scope = encodeURIComponent("https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly");
  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth" +
    `?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URL)}` +
    `&response_type=code` +
    `&access_type=offline` +
    `&prompt=consent` +
    `&scope=${scope}` +
    `&state=${encodeURIComponent(state)}`;

  res.json({ ok: true, authUrl });
});

// 3) Callback OAuth (Google redirige aquí)
router.get("/oauth/callback", async (req, res) => {
  mustEnv();
  const code = String(req.query.code || "");
  const state = String(req.query.state || "");

  if (!code || !state) return res.status(400).send("Missing code/state");

  let tenantId = "";
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
    tenantId = parsed?.tenantId;
  } catch {
    return res.status(400).send("Invalid state");
  }

  // intercambiar code por tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URL,
      grant_type: "authorization_code",
    }),
  });

  const tokenJson: any = await tokenRes.json();
  console.log("🟣 [GCAL CALLBACK] tokenJson:", tokenJson);
  console.log("🟣 [GCAL CALLBACK] has refresh_token:", !!tokenJson?.refresh_token);

  if (!tokenRes.ok) {
    return res.status(400).send("Token exchange failed");
  }

  const access_token = tokenJson.access_token || null;
  const refresh_token = tokenJson.refresh_token || null;
  const expires_in = Number(tokenJson.expires_in || 0);
  const token_expiry = expires_in ? new Date(Date.now() + expires_in * 1000).toISOString() : null;

  const accessEnc = encryptToken(access_token);
  const refreshEnc = encryptToken(refresh_token);

  await pool.query(
    `INSERT INTO google_calendar_integrations
        (tenant_id, connected, calendar_id, refresh_token, updated_at)
    VALUES ($1, TRUE, 'primary', $2, NOW())
    ON CONFLICT (tenant_id)
    DO UPDATE SET
        connected = TRUE,
        refresh_token = COALESCE(EXCLUDED.refresh_token, google_calendar_integrations.refresh_token),
        updated_at = NOW()`,
    [tenantId, refreshEnc]
  );

  // ✅ redirige al dashboard
  return res.redirect("https://www.aamy.ai/dashboard/appointments?google=connected");
});

// 4) Desconectar
router.post("/disconnect", authenticateUser, async (req: any, res) => {
  const tenantId = req.user?.tenant_id;

  await pool.query(
    `UPDATE google_calendar_integrations
        SET connected = FALSE,
            enabled = FALSE,
            access_token = NULL,
            refresh_token = NULL,
            token_expiry = NULL,
            updated_at = NOW()
      WHERE tenant_id = $1`,
    [tenantId]
  );

  return res.json({ ok: true });
});

export default router;
