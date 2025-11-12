// src/routes/channel-status.ts
import { Router, Request, Response } from "express";
import { authenticateUser } from "../middleware/auth";
import { canUseChannel, type Canal } from "../lib/features";
import { getMaintenance } from "../lib/maintenance";

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
    if (!ALLOWED.includes(canal)) return res.status(400).json({ error: "canal_invalid" });

    const tenantId =
      (req as any).user?.tenant_id ??
      (res.locals as any)?.tenant_id ??
      (req as any).tenant_id ??
      (req as any).tenantId;
    if (!tenantId) return res.status(401).json({ error: "unauthorized" });

    // 1) Reglas de plan + toggles + pausa
    const gate = await canUseChannel(tenantId, canal); // { enabled, reason, plan_enabled, settings_enabled, paused_until }

    // 2) Mantenimiento (si lo manejas)
    const maint = await getMaintenance(canal as any, tenantId);
    const maintenance = !!maint?.maintenance;
    const maintenance_message = maint?.message || null;

    // 3) Estado final y razón priorizada
    // prioridad: mantenimiento > pausa > plan
    let reason: "plan" | "maintenance" | "paused" | null = null;
    if (maintenance) reason = "maintenance";
    else if (gate.reason === "paused") reason = "paused";
    else if (!gate.plan_enabled) reason = "plan";

    const blocked =
      maintenance || gate.reason === "paused" || !gate.plan_enabled || !gate.settings_enabled;

    return res.json({
      canal,
      enabled: gate.enabled && !maintenance,
      blocked,
      blocked_by_plan: !gate.plan_enabled,
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
