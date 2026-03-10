// backend/src/routes/estimate-flow.ts
import { Router, Request, Response } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import pool from "../lib/db";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "secret-key";

async function getTenantIdFromCookie(req: Request): Promise<string | null> {
  try {
    const token = req.cookies?.token;
    if (!token) return null;

    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;

    const userId =
      decoded?.id ||
      decoded?.uid ||
      decoded?.user_id;

    if (!userId) return null;

    const { rows } = await pool.query(
      `
      SELECT tenant_id
      FROM users
      WHERE uid = $1
      LIMIT 1
      `,
      [userId]
    );

    return rows?.[0]?.tenant_id || null;
  } catch (err) {
    console.error("❌ estimate-flow auth error:", err);
    return null;
  }
}

// GET /api/estimate-flow/status
router.get("/status", async (req: Request, res: Response) => {
  try {
    const tenantId = await getTenantIdFromCookie(req);

    if (!tenantId) {
      return res.status(401).json({ ok: false, error: "No autorizado" });
    }

    const { rows } = await pool.query(
      `SELECT estimate_flow_enabled
       FROM tenants
       WHERE id = $1
       LIMIT 1`,
      [tenantId]
    );

    return res.json({
      ok: true,
      estimate_flow_enabled: !!rows?.[0]?.estimate_flow_enabled,
    });
  } catch (e: any) {
    console.error("❌ GET /estimate-flow/status error:", e);
    return res.status(500).json({
      ok: false,
      error: "Error al obtener estado de estimate flow",
    });
  }
});

// PATCH /api/estimate-flow/status
router.patch("/status", async (req: Request, res: Response) => {
  try {
    const tenantId = await getTenantIdFromCookie(req);

    if (!tenantId) {
      return res.status(401).json({ ok: false, error: "No autorizado" });
    }

    const estimateFlowEnabled = Boolean(req.body?.estimate_flow_enabled);

    await pool.query("BEGIN");

    const { rows } = await pool.query(
      `UPDATE tenants
       SET estimate_flow_enabled = $2
       WHERE id = $1
       RETURNING estimate_flow_enabled`,
      [tenantId, estimateFlowEnabled]
    );

    // ✅ si activan estimate flow, apaga booking automático
    if (estimateFlowEnabled) {
      await pool.query(
        `
        UPDATE channel_settings
        SET settings_enabled = false
        WHERE tenant_id = $1
          AND canal = 'google_calendar'
        `,
        [tenantId]
      );
    }

    await pool.query("COMMIT");

    return res.json({
      ok: true,
      estimate_flow_enabled: !!rows?.[0]?.estimate_flow_enabled,
    });
  } catch (e: any) {
    try {
      await pool.query("ROLLBACK");
    } catch {}

    console.error("❌ PATCH /estimate-flow/status error:", e);
    return res.status(500).json({
      ok: false,
      error: "Error al actualizar estimate flow",
    });
  }
});

export default router;