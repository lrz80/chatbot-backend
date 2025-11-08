import { Router, Request, Response } from "express";
import { getFeatures, isPaused } from "../lib/features";
import { getMaintenance } from "../lib/maintenance";

const router = Router();

type Canal = "sms" | "email" | "whatsapp" | "meta" | "voice";
const ALLOWED: ReadonlyArray<Canal> = ["sms", "email", "whatsapp", "meta", "voice"] as const;

/**
 * GET /api/channel/status?canal=sms|email|whatsapp|meta|voice
 * Devuelve: enabled, blocked, blocked_by_plan, maintenance, maintenance_message, paused_until, reason
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const canal = String(req.query.canal || "").toLowerCase() as Canal;
    if (!ALLOWED.includes(canal)) {
      return res.status(400).json({ error: "canal_invalid" });
    }

    // Intenta múltiples ubicaciones típicas para tenant_id
    const tenantId =
      (req as any).user?.tenant_id ??
      (res.locals && (res.locals as any).tenant_id) ??
      (req as any).tenant_id ??
      (req as any).tenantId;

    if (!tenantId) return res.status(401).json({ error: "unauthorized" });

    const feats: any = await getFeatures(tenantId);

    // Map flexible por si tus flags usan nombres distintos
    // Esperado: whatsapp_enabled, sms_enabled, meta_enabled, email_enabled, voice_enabled
    const enabledFlag: boolean =
      feats?.[`${canal}_enabled`] ??
      // alternativas por si en tu sistema existen
      (canal === "meta" ? feats?.facebook_enabled || feats?.ig_enabled || feats?.meta : undefined) ??
      false;

    // Pausas: prioriza específicas por canal, luego global
    const pausedUntilRaw: string | Date | null =
      feats?.[`paused_until_${canal}`] ?? feats?.paused_until ?? null;

    // Normaliza a string ISO (frontend hace new Date(...))
    const pausedUntil =
      pausedUntilRaw instanceof Date
        ? pausedUntilRaw.toISOString()
        : pausedUntilRaw
        ? String(pausedUntilRaw)
        : null;

    const maint = await getMaintenance(canal as any, tenantId);
    const maintenanceActive = !!maint?.maintenance;
    const pausedActive = isPaused(pausedUntil);

    // Bloqueo si: no enabled por plan, o mantenimiento, o pausa
    const blocked = !enabledFlag || maintenanceActive || pausedActive;

    const reason: "plan" | "maintenance" | "paused" | null = !enabledFlag
      ? "plan"
      : maintenanceActive
      ? "maintenance"
      : pausedActive
      ? "paused"
      : null;

    return res.json({
      canal,
      enabled: !!enabledFlag,
      blocked,
      blocked_by_plan: !enabledFlag,
      maintenance: maintenanceActive,
      maintenance_message: maint?.message || null,
      paused_until: pausedUntil, // ISO string o null
      reason,
    });
  } catch (e) {
    console.error("channel-status error:", e);
    return res.status(500).json({ error: "internal" });
  }
});

export default router;
