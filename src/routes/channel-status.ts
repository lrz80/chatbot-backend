// src/routes/channel-status.ts
import { Router, Request, Response } from "express";
import dayjs from "dayjs";
import Stripe from "stripe";
import { authenticateUser } from "../middleware/auth";
import { canUseChannel, type Canal } from "../lib/features";
import { getMaintenance } from "../lib/maintenance";
import pool from "../lib/db";

const router = Router();
router.use(authenticateUser);

const ALLOWED: ReadonlyArray<Canal> = [
  "sms",
  "email",
  "whatsapp",
  "meta",
  "voice",
  "google_calendar",
] as const;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2022-11-15",
});

// (LEGACY) planName -> productId (lo dejamos como fallback)
const PLAN_TO_PRODUCT: Record<string, string> = {
  trial: process.env.STRIPE_PRODUCT_TRIAL_ID || "",
  free: process.env.STRIPE_PRODUCT_TRIAL_ID || "",
  starter: process.env.STRIPE_PRODUCT_STARTER_ID || "",
  pro: process.env.STRIPE_PRODUCT_PRO_ID || "",
  business: process.env.STRIPE_PRODUCT_BUSINESS_ID || "",
  enterprise: process.env.STRIPE_PRODUCT_ENTERPRISE_ID || "",
};

// Cache por productId (no por planName)
const FEATURES_CACHE: Record<
  string,
  { exp: number; features: Partial<Record<Canal, boolean>> }
> = {};
const TTL_MS = 10 * 60 * 1000;

function toBool(v?: string | null) {
  return String(v ?? "").toLowerCase() === "true";
}

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

    const features = {
      whatsapp: toBool(md.whatsapp_enabled),
      sms: toBool(md.sms_enabled),
      email: toBool(md.email_enabled),
      meta: toBool(md.meta_enabled),
      voice: toBool(md.voice_enabled),
      // google_calendar no se controla aquí
    };

    FEATURES_CACHE[key] = { exp: Date.now() + TTL_MS, features };
    return features;
  } catch (err) {
    console.error("[channel-status] Stripe product fetch error:", err);
    const fallback = { whatsapp: true, sms: false, email: false, meta: false, voice: false };
    FEATURES_CACHE[key] = { exp: Date.now() + TTL_MS, features: fallback };
    return fallback;
  }
}

// Misma lógica de resolve plan que usas en channel-settings
function resolveEffectivePlan(row: any): { planName: string; trialActive: boolean } {
  const rawPlan = String(row?.plan || "").toLowerCase().trim();

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
 * GET /api/channel/status?canal=sms|email|whatsapp|meta|voice|google_calendar
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

    // 1) Gate base (pausa + toggles, etc.)
    // ⚠️ plan_enabled aquí puede estar mal; lo vamos a sobreescribir
    const gate = await canUseChannel(tenantId, canal);
    // gate: { enabled, reason, plan_enabled, settings_enabled, paused_until }

    // 2) Tenant: plan + extra_features
    const { rows } = await pool.query(
      `SELECT plan, es_trial, trial_ends_at, plan_after_trial, extra_features
       FROM tenants
       WHERE id = $1`,
      [tenantId]
    );
    const tenant = rows[0] || {};
    const extra = (tenant.extra_features as any) || {};
    const { planName } = resolveEffectivePlan(tenant);

    // 3) Plan enabled REAL por Stripe metadata (product_id), no por planName
    let enabledByPlan = true;

    if (canal !== "google_calendar") {
      const productId = resolveProductId(planName, extra);
      const planFeatures = await getFeaturesFromStripeProduct(productId);
      enabledByPlan = !!planFeatures[canal];
    } else {
      enabledByPlan = true; // por ahora
    }

    // 4) Overrides manuales por tenant (admin)
    // Soportamos:
    // - force_meta_pro (legacy)
    // - force_<canal> (nuevo)
    const override =
      extra?.[`force_${canal}`] === true ||
      (canal === "meta" && extra?.force_meta_pro === true) ||
      (canal === "meta" && extra?.force_meta === true);

    const planEnabledFinal = enabledByPlan || override;

    // 5) Mantenimiento
    const maint = await getMaintenance(canal as any, tenantId).catch(() => null);
    const maintenance = !!maint?.maintenance;
    const maintenance_message = maint?.message || null;

    // 6) Razón final priorizada
    let reason: "plan" | "maintenance" | "paused" | "settings" | null = null;

    if (maintenance) reason = "maintenance";
    else if (gate.reason === "paused") reason = "paused";
    else if (!gate.settings_enabled) reason = "settings";
    else if (!planEnabledFinal) reason = "plan";
    else reason = null;

    // 7) Bloqueos finales
    const blocked_by_plan = !planEnabledFinal;

    const blocked =
      maintenance ||
      gate.reason === "paused" ||
      blocked_by_plan ||
      !gate.settings_enabled;

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
