import express, { Request, Response } from "express";
import { authenticateUser } from "../middleware/auth";
import { getMaintenance, getChannelEnabledBySettings } from "../lib/maintenance";
import pool from "../lib/db";

const router = express.Router();

/**
 * GET /api/channel-settings?canal=sms
 * Responde SOLO “mantenimiento” si aplica; y “enabled” separado de plan.
 */
router.get("/", authenticateUser, async (req: Request, res: Response) => {
  try {
    const canal = String(req.query.canal || "").toLowerCase() as any;
    if (!["sms","email","whatsapp","meta","voice"].includes(canal)) {
      return res.status(400).json({ error: "canal inválido" });
    }

    const { tenant_id } = req.user as { tenant_id: string };

    // 1) mantenimiento
    const maint = await getMaintenance(canal, tenant_id);

    // 2) enabled por flags de tenant (NO por plan)
    const enabledBySettings = await getChannelEnabledBySettings(tenant_id, canal);

    // 3) enabled por plan (features del tenant)
    const { rows } = await pool.query(
      `SELECT plan_features FROM tenants WHERE id = $1`, [tenant_id]
    );
    const plan = rows[0]?.plan_features || {};  // ej { sms: true, email: false, ... }
    const enabledByPlan = !!plan[canal];

    const enabled = enabledByPlan && enabledBySettings;

    return res.json({
      canal,
      enabled,                 // ✅ listo para habilitar UI si es true
      plan_enabled: enabledByPlan,
      settings_enabled: enabledBySettings,
      maintenance: maint.maintenance,     // ✅ mostrar “En mantenimiento” SOLO si true
      maintenance_message: maint.message,
      maintenance_window: maint.starts_at || maint.ends_at ? {
        starts_at: maint.starts_at,
        ends_at:   maint.ends_at
      } : null
    });
  } catch (e) {
    console.error("channel-settings error:", e);
    return res.status(500).json({ error: "Error obteniendo estado de canal" });
  }
});

export default router;
