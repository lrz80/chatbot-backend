// backend/src/routes/channel-settings.ts
import express, { Request, Response } from "express";
import dayjs from "dayjs";
import Stripe from "stripe";
import { authenticateUser } from "../middleware/auth";
import { getMaintenance, getChannelEnabledBySettings } from "../lib/maintenance";
import pool from "../lib/db";

const router = express.Router();

type Canal = "sms" | "email" | "whatsapp" | "meta" | "voice";

// ⚠️ Ya NO usamos un mapa hardcodeado de features.
// En su lugar, leemos del Product de Stripe (metadata).
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: '2022-11-15',
});

// Mapea nombre de plan -> Product ID en Stripe (usa envs)
const PLAN_TO_PRODUCT: Record<string, string> = {
  trial: process.env.STRIPE_PRODUCT_TRIAL_ID || "",
  free: process.env.STRIPE_PRODUCT_TRIAL_ID || "", // opcional: trata "free" como trial
  starter: process.env.STRIPE_PRODUCT_STARTER_ID || "",
  pro: process.env.STRIPE_PRODUCT_PRO_ID || "",
  business: process.env.STRIPE_PRODUCT_BUSINESS_ID || "",
  enterprise: process.env.STRIPE_PRODUCT_ENTERPRISE_ID || "",
};

// Cache sencillo para no golpear Stripe en cada request
const FEATURES_CACHE: Record<
  string,
  {
    exp: number;
    features: Partial<Record<Canal, boolean>>;
  }
> = {};
const TTL_MS = 10 * 60 * 1000; // 10 minutos

function toBool(v?: string | null) {
  return String(v ?? "").toLowerCase() === "true";
}

async function getFeaturesFromStripe(planName: string) {
  const key = planName.toLowerCase();
  const hit = FEATURES_CACHE[key];
  if (hit && hit.exp > Date.now()) return hit.features;

  const productId = PLAN_TO_PRODUCT[key];
  if (!productId) {
    // Fallback conservador si el plan no está mapeado
    const fallback = { whatsapp: true, sms: false, email: false, meta: false, voice: false };
    FEATURES_CACHE[key] = { exp: Date.now() + TTL_MS, features: fallback };
    return fallback;
  }

  try {
    const p = await stripe.products.retrieve(productId);
    const md = p.metadata || {};

    const features = {
      whatsapp: toBool(md.whatsapp_enabled),
      sms: toBool(md.sms_enabled),
      email: toBool(md.email_enabled),
      meta: toBool(md.meta_enabled),
      voice: toBool(md.voice_enabled),
    };

    FEATURES_CACHE[key] = { exp: Date.now() + TTL_MS, features };
    return features;
  } catch (err) {
    console.error("[channel-settings] Stripe fetch error:", err);
    // Fallback si Stripe falla
    const fallback = { whatsapp: true, sms: false, email: false, meta: false, voice: false };
    FEATURES_CACHE[key] = { exp: Date.now() + TTL_MS, features: fallback };
    return fallback;
  }
}

/** 🔹 Determina el plan efectivo considerando trial/plan pago */
function resolveEffectivePlan(row: any): { planName: string; trialActive: boolean } {
  const rawPlan = String(row?.plan || "").toLowerCase().trim();

  // Regla: si hay plan pago distinto de trial/free => priorizar
  if (rawPlan && rawPlan !== "trial" && rawPlan !== "free") {
    return { planName: rawPlan, trialActive: false };
  }

  const es_trial = !!row?.es_trial;
  const trial_ends_at = row?.trial_ends_at ? dayjs(row.trial_ends_at) : null;
  const now = dayjs();

  if (es_trial && trial_ends_at && now.isBefore(trial_ends_at)) {
    return { planName: "trial", trialActive: true };
  }

  const planAfter = String(row?.plan_after_trial || "").toLowerCase().trim();
  if (es_trial && trial_ends_at && now.isAfter(trial_ends_at)) {
    if (planAfter) return { planName: planAfter, trialActive: false };
    // fallback razonable
    return { planName: rawPlan || "starter", trialActive: false };
  }

  return { planName: rawPlan || "starter", trialActive: false };
}

/**
 * GET /api/channel-settings?canal=sms|email|whatsapp|meta|voice
 * Responde:
 *   enabled, plan_enabled, settings_enabled, maintenance (+window), plan_current, trial_active
 */
router.get("/", authenticateUser, async (req: Request, res: Response) => {
  try {
    const canal = String(req.query.canal || "").toLowerCase() as Canal;
    if (!["sms", "email", "whatsapp", "meta", "voice"].includes(canal)) {
      return res.status(400).json({ error: "canal inválido" });
    }

    const { tenant_id } = req.user as { tenant_id: string };
    if (!tenant_id) return res.status(401).json({ error: "unauthorized" });

    // 1) Mantenimiento (global + tenant)
    const maintRaw = await getMaintenance(canal, tenant_id).catch(() => null);
    const maint = {
      maintenance: !!maintRaw?.maintenance,
      message: maintRaw?.message || null,
      starts_at: maintRaw?.starts_at || null,
      ends_at: maintRaw?.ends_at || null,
    };

    // 2) Toggle por tenant
    const settingsEnabled = !!(await getChannelEnabledBySettings(tenant_id, canal));

    // 3) Plan del tenant
    const { rows } = await pool.query(
      `SELECT plan, es_trial, trial_ends_at, plan_after_trial, extra_features 
      FROM tenants 
      WHERE id = $1`,
      [tenant_id]
    );

    const tenant = rows[0] || {};
    const { planName, trialActive } = resolveEffectivePlan(tenant);

    // 👇 Leemos extra_features (puede ser null)
    const extra = (tenant.extra_features as any) || {};

    // 4) Features del plan desde Stripe
    const planFeatures = await getFeaturesFromStripe(planName);

    // Por defecto, lo que diga Stripe
    let enabledByPlan = !!planFeatures[canal];

    // 🟣 OVERRIDE limpio: tu tenant Starter con Meta “Pro”
    if (canal === "meta" && extra.force_meta_pro === true) {
      enabledByPlan = true;
    }

    // 5) Gate final
    const enabled = enabledByPlan && settingsEnabled && !maint.maintenance;

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      canal,
      enabled,
      plan_enabled: enabledByPlan,
      settings_enabled: settingsEnabled,
      maintenance: maint.maintenance,
      maintenance_message: maint.message,
      maintenance_window:
        maint.starts_at || maint.ends_at ? { starts_at: maint.starts_at, ends_at: maint.ends_at } : null,
      plan_current: planName,
      trial_active: trialActive,
      trial_ends_at: tenant.trial_ends_at || null,
    });
  } catch (e) {
    console.error("channel-settings error:", e);
    return res.status(500).json({ error: "Error obteniendo estado de canal" });
  }
});

export default router;
