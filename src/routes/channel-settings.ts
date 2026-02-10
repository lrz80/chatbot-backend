// backend/src/routes/channel-settings.ts
import express, { Request, Response } from "express";
import dayjs from "dayjs";
import Stripe from "stripe";
import { authenticateUser } from "../middleware/auth";
import { getMaintenance, getChannelEnabledBySettings } from "../lib/maintenance";
import pool from "../lib/db";

const router = express.Router();

type Canal = "sms" | "email" | "whatsapp" | "meta" | "voice" | "google_calendar";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2022-11-15",
});

/**
 * ✅ (LEGACY) Mapa nombre_plan -> product_id
 * Puedes dejarlo, pero YA NO ES el mecanismo principal.
 * Si el plan es "test" u otro, no dependemos de esto.
 */
const PLAN_TO_PRODUCT: Record<string, string> = {
  trial: process.env.STRIPE_PRODUCT_TRIAL_ID || "",
  free: process.env.STRIPE_PRODUCT_TRIAL_ID || "",
  starter: process.env.STRIPE_PRODUCT_STARTER_ID || "",
  pro: process.env.STRIPE_PRODUCT_PRO_ID || "",
  business: process.env.STRIPE_PRODUCT_BUSINESS_ID || "",
  enterprise: process.env.STRIPE_PRODUCT_ENTERPRISE_ID || "",
};

// Cache por product_id (no por plan)
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

/**
 * ✅ Resuelve product_id SIN depender del nombre del plan.
 * Prioridad:
 *  1) tenants.extra_features.stripe_product_id  (admin / tu control)
 *  2) env STRIPE_DEFAULT_PRODUCT_ID (opcional, fallback global)
 *  3) legacy PLAN_TO_PRODUCT[planName]
 */
function resolveProductId(planName: string, extra: any): string {
  const fromExtra = String(extra?.stripe_product_id || "").trim();
  if (fromExtra) return fromExtra;

  const fromEnvDefault = String(process.env.STRIPE_DEFAULT_PRODUCT_ID || "").trim();
  if (fromEnvDefault) return fromEnvDefault;

  const legacy = PLAN_TO_PRODUCT[String(planName || "").toLowerCase().trim()];
  return String(legacy || "").trim();
}

async function getFeaturesFromStripeProduct(productId: string) {
  const key = String(productId || "").trim();
  if (!key) {
    // fallback conservador
    return { whatsapp: true, sms: false, email: false, meta: false, voice: false };
  }

  const hit = FEATURES_CACHE[key];
  if (hit && hit.exp > Date.now()) return hit.features;

  try {
    const p = await stripe.products.retrieve(key);
    const md = p.metadata || {};

    // ✅ lectura por metadata del PRODUCT (Stripe)
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
    console.error("[channel-settings] Stripe product fetch error:", err);
    const fallback = { whatsapp: true, sms: false, email: false, meta: false, voice: false };
    FEATURES_CACHE[key] = { exp: Date.now() + TTL_MS, features: fallback };
    return fallback;
  }
}

/** 🔹 Determina el plan efectivo considerando trial/plan pago */
function resolveEffectivePlan(row: any): { planName: string; trialActive: boolean } {
  const rawPlan = String(row?.plan || "").toLowerCase().trim();

  // Si hay plan pago distinto de trial/free => priorizar
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
    return { planName: rawPlan || "starter", trialActive: false };
  }

  return { planName: rawPlan || "starter", trialActive: false };
}

/**
 * GET /api/channel-settings?canal=sms|email|whatsapp|meta|voice|google_calendar
 * Responde:
 *   enabled, plan_enabled, settings_enabled, maintenance (+window), plan_current, trial_active
 */
router.get("/", authenticateUser, async (req: Request, res: Response) => {
  try {
    const canal = String(req.query.canal || "").toLowerCase() as Canal;
    if (!["sms", "email", "whatsapp", "meta", "voice", "google_calendar"].includes(canal)) {
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

    // 2) Toggle por tenant (settings)
    let settingsEnabled = false;

    if (canal === "google_calendar") {
      const { rows: csRows } = await pool.query(
        `SELECT google_calendar_enabled
         FROM channel_settings
         WHERE tenant_id = $1
         LIMIT 1`,
        [tenant_id]
      );
      settingsEnabled = csRows[0]?.google_calendar_enabled === true;
    } else {
      settingsEnabled = !!(await getChannelEnabledBySettings(tenant_id, canal));
    }

    // 3) Tenant plan + overrides
    const { rows } = await pool.query(
      `SELECT plan, es_trial, trial_ends_at, plan_after_trial, extra_features
       FROM tenants
       WHERE id = $1`,
      [tenant_id]
    );

    const tenant = rows[0] || {};
    const { planName, trialActive } = resolveEffectivePlan(tenant);

    // 👇 extra_features (jsonb) para overrides/admin
    const extra = (tenant.extra_features as any) || {};

    // ✅ 3.1 Resolver product_id SIN depender del nombre del plan
    const productId = resolveProductId(planName, extra);

    // 4) Features del plan desde Stripe PRODUCT metadata
    const planFeatures = await getFeaturesFromStripeProduct(productId);

    // 5) enabledByPlan
    const enabledByPlan = canal === "google_calendar" ? true : !!planFeatures[canal];

    // ✅ Override manual por tenant (admin)
    const enabledByOverride =
      extra?.[`force_${canal}`] === true ||
      (canal === "meta" && extra?.force_meta === true);

    // ✅ Resultado final: plan OR override
    const enabledEffective = enabledByPlan || enabledByOverride;

    // 6) Gate final
    const enabled = enabledEffective && settingsEnabled && !maint.maintenance;

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      canal,
      enabled,
      plan_enabled: enabledEffective, // lo efectivo (Stripe PRODUCT metadata OR override)
      settings_enabled: settingsEnabled,
      maintenance: maint.maintenance,
      maintenance_message: maint.message,
      maintenance_window:
        maint.starts_at || maint.ends_at ? { starts_at: maint.starts_at, ends_at: maint.ends_at } : null,
      plan_current: planName,
      trial_active: trialActive,
      trial_ends_at: tenant.trial_ends_at || null,

      // ✅ debug (para que veas qué product está usando)
      product_id_used: productId || null,
    });
  } catch (e) {
    console.error("channel-settings error:", e);
    return res.status(500).json({ error: "Error obteniendo estado de canal" });
  }
});

/**
 * PATCH /api/channel-settings
 * Body: { canal: "google_calendar", enabled: boolean }
 */
router.patch("/", authenticateUser, async (req: Request, res: Response) => {
  try {
    const { tenant_id } = req.user as { tenant_id: string };
    if (!tenant_id) return res.status(401).json({ error: "unauthorized" });

    const canal = String(req.body?.canal || "").toLowerCase() as Canal;
    const enabled = req.body?.enabled;

    if (canal !== "google_calendar") {
      return res.status(400).json({ error: "Solo se permite actualizar google_calendar aquí" });
    }
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be boolean" });
    }

    await pool.query(
      `INSERT INTO channel_settings (tenant_id, google_calendar_enabled, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (tenant_id)
       DO UPDATE SET google_calendar_enabled = EXCLUDED.google_calendar_enabled`,
      [tenant_id, enabled]
    );

    return res.json({ ok: true, canal, google_calendar_enabled: enabled });
  } catch (e) {
    console.error("channel-settings PATCH error:", e);
    return res.status(500).json({ error: "Error actualizando estado de canal" });
  }
});

export default router;
