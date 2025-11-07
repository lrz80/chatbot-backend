import { Router, Request, Response } from "express";
import pool from "../../lib/db";

const router = Router();

// Middleware MUY simple para proteger el cron con un secreto
function requireCronSecret(req: Request, res: Response, next: Function) {
  const secret = process.env.CRON_SECRET?.trim();
  const header = String(req.headers["x-cron-secret"] || "");
  if (!secret || header !== secret) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

/**
 * POST /api/internal/cron/flip-trials
 * Cambia automáticamente:
 *   - plan = plan_after_trial (o 'starter' si está vacío)
 *   - es_trial = false
 *   - SOLO si trial_ends_at < NOW()
 */
router.post("/flip-trials", requireCronSecret, async (_req: Request, res: Response) => {
  try {
    const q = `
      UPDATE tenants
      SET
        plan = COALESCE(NULLIF(plan_after_trial,''), CASE WHEN plan <> 'trial' THEN plan ELSE 'starter' END),
        es_trial = false
      WHERE es_trial = true
        AND trial_ends_at IS NOT NULL
        AND trial_ends_at < NOW()
    `;
    const r = await pool.query(q);
    return res.json({ flipped: r.rowCount });
  } catch (e) {
    console.error("flip-trials error:", e);
    return res.status(500).json({ error: "flip-trials failed" });
  }
});

export default router;
