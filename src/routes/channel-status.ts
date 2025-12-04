// src/routes/channel-status.ts
import { Router, Request, Response } from "express";
import { authenticateUser } from "../middleware/auth";
import { canUseChannel, type Canal } from "../lib/features";
import { getMaintenance } from "../lib/maintenance";
import pool from "../lib/db";

const router = Router();
router.use(authenticateUser);

const ALLOWED: ReadonlyArray<Canal> = ["sms", "email", "whatsapp", "meta", "voice"] as const;

/**
 * GET /api/channel/status?canal=sms|email|whatsapp|meta|voice
 * Responde: enabled, blocked, blocked_by_plan, maintenance, maintenance_message, paused_until, reason
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const canal = String(req.query.canal || "").toLowerCase() as Canal;
    if (!ALLOWED.includes(canal)) {
      return res.status(400).json({ error: "canal_invalid" });
    }

    const tenantId =
      (req as any).user?.tenant_id ??
      (res.locals as any)?.tenant_id ??
      (req as any).tenant_id ??
      (req as any).tenantId;

    if (!tenantId) return res.status(401).json({ error: "unauthorized" });

    // 1) Reglas base: plan + toggles + pausa
    const gate = await canUseChannel(tenantId, canal);
    // gate: { enabled, reason, plan_enabled, settings_enabled, paused_until }

    // 2) Leer extra_features del tenant (para overrides manuales)
    const { rows } = await pool.query(
      `SELECT extra_features FROM tenants WHERE id = $1`,
      [tenantId]
    );
    const extra = (rows[0]?.extra_features as any) || {};

    // 3) Override manual: si este tenant tiene force_meta_pro => ignora bloqueo de plan en META
    const forceMetaPro =
      canal === "meta" && extra && extra.force_meta_pro === true;

    // plan_enabled FINAL después del override
    const planEnabledFinal = gate.plan_enabled || forceMetaPro;

    // 4) Mantenimiento
    const maint = await getMaintenance(canal as any, tenantId);
    const maintenance = !!maint?.maintenance;
    const maintenance_message = maint?.message || null;

    // 5) Razón final priorizada
    // prioridad: mantenimiento > pausa > plan
    let reason: "plan" | "maintenance" | "paused" | null = null;

    if (maintenance) {
      reason = "maintenance";
    } else if (gate.reason === "paused") {
      reason = "paused";
    } else if (!planEnabledFinal) {
      // solo plan si realmente está deshabilitado por plan (después del override)
      reason = "plan";
    } else {
      reason = null;
    }

    // 6) Bloqueos finales
    const blocked_by_plan = !planEnabledFinal;
    const blocked =
      maintenance ||
      gate.reason === "paused" ||
      blocked_by_plan ||
      !gate.settings_enabled;

    // enabled ya NO usa gate.enabled, porque allí no se conoce el override
    const enabled = !blocked;

    return res.json({
      canal,
      enabled,
      blocked,
      blocked_by_plan,
      maintenance,
      maintenance_message,
      paused_until: gate.paused_until,
      reason,
    });
  } catch (e) {
    console.error("channel-status error:", e);
    return res.status(500).json({ error: "internal" });
  }
});

export default router;
