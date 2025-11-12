// src/routes/channel-status.ts
import { Router, Request, Response } from "express";
import { getFeatures, isPaused } from "../lib/features";
import { getMaintenance } from "../lib/maintenance";
import { authenticateUser } from "../middleware/auth"; 
import pool from "../lib/db";                           // ⬅️ importa DB para leer tenants

const router = Router();
router.use(authenticateUser);

type Canal = "sms" | "email" | "whatsapp" | "meta" | "voice";
const ALLOWED: ReadonlyArray<Canal> = ["sms", "email", "whatsapp", "meta", "voice"] as const;

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

    const feats: any = await getFeatures(tenantId);

    // Flag por plan (channel_settings)
    const enabledFlag: boolean =
      feats?.[`${canal}_enabled`] ??
      (canal === "meta"
        ? feats?.facebook_enabled || feats?.ig_enabled || feats?.meta
        : undefined) ??
      false;

    // ⬇️ 1) Lee membresía/trial del tenant
    const tRes = await pool.query(
      `SELECT membresia_activa, membresia_vigencia, es_trial
         FROM tenants
        WHERE id = $1
        LIMIT 1`,
      [tenantId]
    );
    const t = tRes.rows[0];
    const hoy = new Date();
    const vigencia = t?.membresia_vigencia ? new Date(t.membresia_vigencia) : null;
    const trial_activo = Boolean(t?.es_trial && vigencia && vigencia >= hoy);
    const plan_activo = Boolean(t?.membresia_activa);
    const can_edit = plan_activo || trial_activo;   // 👈 requisito para “enabled”

    // Pausa específica del canal > pausa global
    const pausedUntilRaw: string | Date | null =
      feats?.[`paused_until_${canal}`] ?? feats?.paused_until ?? null;
    const paused_until =
      pausedUntilRaw instanceof Date
        ? pausedUntilRaw.toISOString()
        : pausedUntilRaw
        ? String(pausedUntilRaw)
        : null;

    // Mantenimiento
    const maint = await getMaintenance(canal as any, tenantId);
    const maintenanceActive = !!maint?.maintenance;
    const pausedActive = isPaused(paused_until);

    // ⬇️ 2) enabled ahora depende del plan + membresía/trial + runtime
    const enabled = enabledFlag && can_edit && !maintenanceActive && !pausedActive;

    // Motivo de bloqueo:
    // - Si el plan no lo incluye, razón = "plan"
    // - Si hay mantenimiento, razón = "maintenance"
    // - Si está en pausa, razón = "paused"
    // - Si solo falta membresía/trial, dejamos reason = null (tu UI general ya muestra “Activa tu membresía”)
    let reason: "plan" | "maintenance" | "paused" | null = null;
    if (!enabledFlag) reason = "plan";
    else if (maintenanceActive) reason = "maintenance";
    else if (pausedActive) reason = "paused";

    const blocked_by_plan = !enabledFlag;
    const blocked = blocked_by_plan || maintenanceActive || pausedActive || !can_edit;

    return res.json({
      canal,
      enabled,
      blocked,
      blocked_by_plan,
      maintenance: maintenanceActive,
      maintenance_message: maint?.message || null,
      paused_until,
      reason,
    });
  } catch (e) {
    console.error("channel-status error:", e);
    return res.status(500).json({ error: "internal" });
  }
});

export default router;
