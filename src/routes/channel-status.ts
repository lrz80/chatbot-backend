// src/routes/channel-status.ts
import { Router, Request, Response } from "express";
import { canUseChannel } from "../lib/features";   // 👈 usa el gate unificado
import { getMaintenance } from "../lib/maintenance";
import { authenticateUser } from "../middleware/auth";

const router = Router();
router.use(authenticateUser);

type Canal = "sms" | "email" | "whatsapp" | "meta" | "voice";
const ALLOWED: ReadonlyArray<Canal> = ["sms", "email", "whatsapp", "meta", "voice"] as const;

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

    // 1) Gate único: plan + settings + pausas
    const gate = await canUseChannel(tenantId, canal);

    // 2) (Opcional) mantenimiento por canal/tenant
    const maint = await getMaintenance(canal as any, tenantId);
    const maintenanceActive = !!maint?.maintenance;

    // 3) Estado final para UI
    const enabled = gate.enabled && !maintenanceActive;
    const blocked_by_plan = !gate.plan_enabled;
    const blocked = !enabled || blocked_by_plan || maintenanceActive;

    return res.json({
      canal,
      enabled,
      blocked,
      blocked_by_plan,
      maintenance: maintenanceActive,
      maintenance_message: maint?.message || null,
      paused_until: gate.paused_until ? gate.paused_until.toISOString() : null,
      reason: blocked_by_plan ? "plan" : (gate.reason ?? (maintenanceActive ? "maintenance" : null)),
      // opcional: diagnósticos útiles para el cliente
      diagnostics: {
        plan_enabled: gate.plan_enabled,
        settings_enabled: gate.settings_enabled,
      },
    });
  } catch (e) {
    console.error("channel-status error:", e);
    return res.status(500).json({ error: "internal" });
  }
});

export default router;
