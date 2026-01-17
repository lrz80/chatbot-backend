// src/routes/booking-settings.ts
import { Router, Request, Response } from "express";
import { authenticateUser } from "../middleware/auth";
import pool from "../lib/db";

const router = Router();

/**
 * Source of truth:
 * - channel_settings.google_calendar_enabled
 *
 * This route stays as a compatibility wrapper for the frontend that still uses:
 * - /api/booking-settings
 * - booking_enabled
 */

/**
 * GET /api/booking-settings
 */
router.get("/", authenticateUser, async (req: Request, res: Response) => {
  const tenantId = (req as any).user?.tenant_id;
  if (!tenantId) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });

  try {
    const { rows } = await pool.query(
      `SELECT google_calendar_enabled
         FROM channel_settings
        WHERE tenant_id = $1
        LIMIT 1`,
      [tenantId]
    );

    // default OFF if row missing (safer)
    const booking_enabled = rows[0]?.google_calendar_enabled === true;

    return res.json({ ok: true, booking_enabled });
  } catch (e: any) {
    console.error("❌ GET /booking-settings failed:", e?.message);
    return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
  }
});

/**
 * PUT /api/booking-settings
 * Body: { booking_enabled: boolean }
 *
 * Writes to channel_settings.google_calendar_enabled
 */
router.put("/", authenticateUser, async (req: Request, res: Response) => {
  const tenantId = (req as any).user?.tenant_id;
  if (!tenantId) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });

  const { booking_enabled } = req.body as { booking_enabled?: boolean };
  if (typeof booking_enabled !== "boolean") {
    return res.status(400).json({ ok: false, error: "booking_enabled_must_be_boolean" });
  }

  try {
    // Ensure row exists (idempotent)
    await pool.query(
      `INSERT INTO channel_settings (tenant_id, google_calendar_enabled, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (tenant_id)
       DO UPDATE SET google_calendar_enabled = EXCLUDED.google_calendar_enabled`,
      [tenantId, booking_enabled]
    );

    return res.json({ ok: true, booking_enabled });
  } catch (e: any) {
    console.error("❌ PUT /booking-settings failed:", e?.message);
    return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
  }
});

export default router;
