// backend/src/routes/appointment-settings.ts
import { Router } from "express";
import pool from "../lib/db";
import { authenticateUser } from "../middleware/auth";

const router = Router();

/**
 * GET /api/appointment-settings
 * Devuelve configuración de agendamiento del tenant (con defaults si no existe fila).
 */
router.get("/", authenticateUser, async (req: any, res) => {
  const tenantId = req.user?.tenant_id;
  if (!tenantId) return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    const { rows } = await pool.query(
      `SELECT tenant_id, default_duration_min, buffer_min, timezone, enabled, min_lead_minutes
        FROM appointment_settings
        WHERE tenant_id = $1
        LIMIT 1`,
      [tenantId]
    );

    // Defaults si no existe fila todavía
    const defaults = {
      tenant_id: tenantId,
      default_duration_min: 30,
      buffer_min: 10,
      min_lead_minutes: 60,
      timezone: "America/New_York",
      enabled: true,
    };

    return res.json({ ok: true, settings: rows[0] ?? defaults });
  } catch (err: any) {
    console.error("❌ [appointment-settings][GET]", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

/**
 * POST /api/appointment-settings
 * Guarda configuración de agendamiento del tenant (UPSERT).
 */
router.post("/", authenticateUser, async (req: any, res) => {
  const tenantId = req.user?.tenant_id;
  if (!tenantId) return res.status(401).json({ ok: false, error: "Unauthorized" });

  const {
    default_duration_min,
    buffer_min,
    timezone,
    enabled,
    min_lead_minutes,
  } = req.body || {};

  // Validaciones mínimas (MVP)
  const dur = Number(default_duration_min);
  const buf = Number(buffer_min);

  const lead = Number(min_lead_minutes);

  if (!Number.isFinite(lead) || lead < 0 || lead > 1440) {
    return res.status(400).json({ ok: false, error: "min_lead_minutes inválido (0–1440)" });
  }

  if (!Number.isFinite(dur) || dur < 5 || dur > 480) {
    return res.status(400).json({ ok: false, error: "default_duration_min inválido (5–480)" });
  }
  if (!Number.isFinite(buf) || buf < 0 || buf > 120) {
    return res.status(400).json({ ok: false, error: "buffer_min inválido (0–120)" });
  }
  if (!timezone || typeof timezone !== "string" || timezone.length < 3 || timezone.length > 64) {
    return res.status(400).json({ ok: false, error: "timezone inválido" });
  }

  // enabled opcional: si no viene, respeta lo que exista (o default true)
  const enabledVal =
    typeof enabled === "boolean" ? enabled : true;

  try {
    const { rows } = await pool.query(
      `INSERT INTO appointment_settings
        (tenant_id, default_duration_min, buffer_min, min_lead_minutes, timezone, enabled, created_at, updated_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, now(), now())
      ON CONFLICT (tenant_id)
      DO UPDATE SET
        default_duration_min = EXCLUDED.default_duration_min,
        buffer_min = EXCLUDED.buffer_min,
        min_lead_minutes = EXCLUDED.min_lead_minutes,   -- ✅ NUEVO
        timezone = EXCLUDED.timezone,
        enabled = EXCLUDED.enabled,
        updated_at = now()
      RETURNING tenant_id, default_duration_min, buffer_min, min_lead_minutes, timezone, enabled`,
      [tenantId, dur, buf, lead, timezone, enabledVal]
    );

    return res.json({ ok: true, settings: rows[0] });
  } catch (err: any) {
    console.error("❌ [appointment-settings][POST]", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

export default router;
