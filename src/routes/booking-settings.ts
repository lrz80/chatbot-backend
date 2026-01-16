import { Router, Request, Response } from "express";
import { authenticateUser } from "../middleware/auth";
import pool from "../lib/db";

const router = Router();

/**
 * GET /api/booking-settings
 * Devuelve booking_enabled y booking_link desde tenants.hints
 */
router.get("/", authenticateUser, async (req: Request, res: Response) => {
  const tenantId = (req as any).user?.tenant_id;
  if (!tenantId) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });

  const { rows } = await pool.query(
    `SELECT hints FROM tenants WHERE id = $1 LIMIT 1`,
    [tenantId]
  );

  let booking_enabled = true;
  let booking_link: string | null = null;

  try {
    const hints = rows[0]?.hints;
    const obj = typeof hints === "string" ? JSON.parse(hints) : (hints || {});
    if (typeof obj.booking_enabled === "boolean") booking_enabled = obj.booking_enabled;
    if (obj.booking_link) booking_link = String(obj.booking_link).trim() || null;
  } catch {}

  return res.json({ ok: true, booking_enabled, booking_link });
});

/**
 * PUT /api/booking-settings
 * Actualiza hints.booking_enabled
 */
router.put("/", authenticateUser, async (req: Request, res: Response) => {
  const tenantId = (req as any).user?.tenant_id;
  if (!tenantId) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });

  const { booking_enabled } = req.body as { booking_enabled?: boolean };
  if (typeof booking_enabled !== "boolean") {
    return res.status(400).json({ ok: false, error: "booking_enabled_must_be_boolean" });
  }

  const { rows } = await pool.query(
    `SELECT hints FROM tenants WHERE id = $1 LIMIT 1`,
    [tenantId]
  );

  let obj: any = {};
  try {
    const hints = rows[0]?.hints;
    obj = typeof hints === "string" ? JSON.parse(hints) : (hints || {});
  } catch {
    obj = {};
  }

  obj.booking_enabled = booking_enabled;

  await pool.query(
    `UPDATE tenants SET hints = $1, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(obj), tenantId]
  );

  return res.json({ ok: true, booking_enabled });
});

export default router;
