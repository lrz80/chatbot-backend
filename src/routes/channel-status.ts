import { Router, Request, Response } from "express";
import { getFeatures, isPaused } from "../lib/features";
import { getMaintenance } from "../lib/maintenance";

const router = Router();

/**
 * GET /api/channel/status?canal=sms|email|whatsapp|meta|voice
 * Devuelve: enabled, maintenance, blocked_by_plan, paused_until, message
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const canal = String(req.query.canal || "").toLowerCase();
    if (!["sms", "email", "whatsapp", "meta", "voice"].includes(canal)) {
      return res.status(400).json({ error: "canal_invalid" });
    }

    const tenantId =
      (req as any).user?.tenant_id ||
      (req as any).tenant_id ||
      (req as any).tenantId;

    if (!tenantId) return res.status(401).json({ error: "unauthorized" });

    const feats = await getFeatures(tenantId);
    const enabledFlag = !!feats[`${canal}_enabled`];

    const pausedUntil =
      feats[`paused_until_${canal}`] || feats.paused_until || null;

    const maint = await getMaintenance(canal as any, tenantId);

    const maintenanceActive = !!maint.maintenance;
    const pausedActive = isPaused(pausedUntil);

    // Regla: bloqueado si NO enabled, o si hay mantenimiento, o si está pausado
    const blocked = !enabledFlag || maintenanceActive || pausedActive;

    // Mensaje razon
    const reason = !enabledFlag
      ? "plan"
      : maintenanceActive
      ? "maintenance"
      : pausedActive
      ? "paused"
      : null;

    return res.json({
      canal,
      enabled: enabledFlag,
      blocked,
      blocked_by_plan: !enabledFlag,
      maintenance: maintenanceActive,
      maintenance_message: maint.message || null,
      paused_until: pausedUntil || null,
      reason,
    });
  } catch (e) {
    console.error("channel-status error:", e);
    return res.status(500).json({ error: "internal" });
  }
});

export default router;
