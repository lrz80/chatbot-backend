// src/routes/integrations/google-calendar.ts
import { Router, Request, Response } from "express";
import { authenticateUser } from "../../middleware/auth";
import pool from "../../lib/db";
import { canUseChannel } from "../../lib/features";
import fetch from "node-fetch"; // si estás en Node 18 y TS lo permite, puedes usar fetch global sin importar
import { encryptToken } from "../../services/googleCrypto";


const router = Router();
router.use(authenticateUser);

/**
 * GET /api/integrations/google-calendar/status
 * Devuelve estado de conexión (sin tokens) + gating del switch
 */
router.get("/status", async (req: Request, res: Response) => {
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

router.get("/connect", async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    if (!tenantId) return res.status(401).json({ error: "unauthorized" });

    const gate = await canUseChannel(tenantId, "google_calendar");
    if (!gate.settings_enabled) {
      return res.status(403).json({ error: "google_calendar_disabled" });
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URL;
    if (!clientId || !redirectUri) {
      return res.status(500).json({ error: "google_oauth_not_configured" });
    }

    // state firmado simple (tenantId + timestamp). Si prefieres JWT, lo hacemos luego.
    const state = Buffer.from(JSON.stringify({ tenantId, t: Date.now() })).toString("base64url");

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

router.get("/callback", async (req: Request, res: Response) => {
  try {
    const { code, state } = req.query as any;
    if (!code || !state) return res.status(400).send("Missing code/state");

    const decoded = JSON.parse(Buffer.from(String(state), "base64url").toString("utf8"));
    const tenantId = decoded?.tenantId;
    if (!tenantId) return res.status(400).send("Invalid state");

    // Gate de seguridad adicional: el usuario autenticado debe ser del mismo tenant
    const authTenantId = (req as any).user?.tenant_id;
    if (!authTenantId || authTenantId !== tenantId) {
      return res.status(403).send("Tenant mismatch");
    }

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
