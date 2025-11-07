import express, { Request, Response } from "express";
import dayjs from "dayjs";
import { authenticateUser } from "../middleware/auth";
import { getMaintenance, getChannelEnabledBySettings } from "../lib/maintenance";
import pool from "../lib/db";

const router = express.Router();

type Canal = "sms" | "email" | "whatsapp" | "meta" | "voice";

/** 🔹 Define los canales habilitados por plan */
const PLAN_FEATURES: Record<string, Partial<Record<Canal, boolean>>> = {
  trial:     { whatsapp: true,  sms: false, email: false, meta: false, voice: false },
  starter:   { whatsapp: true,  sms: false, email: false, meta: false, voice: false },
  pro:       { whatsapp: true,  sms: true,  email: true,  meta: true,  voice: false },
  business:  { whatsapp: true,  sms: true,  email: true,  meta: true,  voice: true  },
  enterprise:{ whatsapp: true,  sms: true,  email: true,  meta: true,  voice: true  },
};

/** 🔹 Determina qué plan está activo considerando trial */
function resolveEffectivePlan(row: any): { planName: string; trialActive: boolean } {
  const plan = String(row?.plan || "").toLowerCase() || "trial";
  const es_trial = !!row?.es_trial;
  const trial_ends_at = row?.trial_ends_at ? dayjs(row.trial_ends_at) : null;
  const now = dayjs();

  // Si el trial sigue vigente
  if (es_trial && trial_ends_at && now.isBefore(trial_ends_at)) {
    return { planName: "trial", trialActive: true };
  }

  // Si el trial venció y hay plan_after_trial definido
  const planAfter = String(row?.plan_after_trial || "").toLowerCase().trim();
  if (es_trial && trial_ends_at && now.isAfter(trial_ends_at)) {
    if (planAfter) return { planName: planAfter, trialActive: false };
    if (plan && plan !== "trial") return { planName: plan, trialActive: false };
    return { planName: "starter", trialActive: false };
  }

  // Si no está en trial
  return { planName: plan || "starter", trialActive: false };
}

/**
 * GET /api/channel-settings?canal=sms|email|whatsapp|meta|voice
 * Devuelve:
 *   - enabled (final)
 *   - plan_enabled
 *   - settings_enabled
 *   - maintenance (+window)
 *   - plan_current / trial_active
 */
router.get("/", authenticateUser, async (req: Request, res: Response) => {
  try {
    const canal = String(req.query.canal || "").toLowerCase() as Canal;
    if (!["sms","email","whatsapp","meta","voice"].includes(canal)) {
      return res.status(400).json({ error: "canal inválido" });
    }

    const { tenant_id } = req.user as { tenant_id: string };
    if (!tenant_id) return res.status(401).json({ error: "unauthorized" });

    // 1️⃣ mantenimiento (global + tenant)
    const maintRaw = await getMaintenance(canal, tenant_id).catch(() => null);
    const maint = {
      maintenance: !!maintRaw?.maintenance,
      message: maintRaw?.message || null,
      starts_at: maintRaw?.starts_at || null,
      ends_at: maintRaw?.ends_at || null,
    };

    // 2️⃣ flags de activación del canal (toggle global/tenant)
    const settingsEnabled = !!(await getChannelEnabledBySettings(tenant_id, canal));

    // 3️⃣ leer plan/es_trial/trial_ends_at/plan_after_trial
    const { rows } = await pool.query(
      `SELECT plan, es_trial, trial_ends_at, plan_after_trial 
       FROM tenants 
       WHERE id = $1`,
      [tenant_id]
    );

    const tenant = rows[0] || {};
    const { planName, trialActive } = resolveEffectivePlan(tenant);

    // 4️⃣ enabled por plan
    const enabledByPlan = !!PLAN_FEATURES[planName]?.[canal];

    // 5️⃣ habilitado final para la UI
    const enabled = enabledByPlan && settingsEnabled && !maint.maintenance;

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      canal,
      enabled,                  // ✅ control final para UI
      plan_enabled: enabledByPlan,
      settings_enabled: settingsEnabled,
      maintenance: maint.maintenance,
      maintenance_message: maint.message,
      maintenance_window: (maint.starts_at || maint.ends_at)
        ? { starts_at: maint.starts_at, ends_at: maint.ends_at }
        : null,
      plan_current: planName,
      trial_active: trialActive,
      trial_ends_at: tenant.trial_ends_at || null,
    });
  } catch (e) {
    console.error("channel-settings error:", e);
    return res.status(500).json({ error: "Error obteniendo estado de canal" });
  }
}); // ✅ cierre del router.get

export default router; // ✅ cierre del archivo
