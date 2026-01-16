// src/routes/integrations/google-calendar.ts
import { Router, Request, Response } from "express";
import { authenticateUser } from "../../middleware/auth";
import pool from "../../lib/db";
import { canUseChannel } from "../../lib/features";

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

export default router;
