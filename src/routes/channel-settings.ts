// backend/src/routes/channel-settings.ts
import express, { Request, Response } from "express";
import dayjs from "dayjs";
import Stripe from "stripe";
import { authenticateUser } from "../middleware/auth";
import { getMaintenance, getChannelEnabledBySettings } from "../lib/maintenance";
import pool from "../lib/db";

const router = express.Router();

type Canal = "sms" | "email" | "whatsapp" | "meta" | "voice" | "google_calendar";

// ⚠️ Ya NO usamos un mapa hardcodeado de features por nombre de plan.
// En su lugar, leemos del Product de Stripe (metadata) usando PRODUCT ID.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2022-11-15",
});

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

/**
 * ✅ Obtiene features desde Stripe usando PRODUCT ID
 * Lee:
 *  - whatsapp_enabled
 *  - sms_enabled
 *  - email_enabled
 *  - meta_enabled
 *  - voice_enabled
 */
async function getFeaturesFromStripeByProductId(productId: string) {
  const key = `prod:${productId}`;
  const hit = FEATURES_CACHE[key];
  if (hit && hit.exp > Date.now()) return hit.features;

  try {
    const p = await stripe.products.retrieve(productId);
    const md = p.metadata || {};

    const features: Partial<Record<Canal, boolean>> = {
      whatsapp: toBool(md.whatsapp_enabled),
      sms: toBool(md.sms_enabled),
      email: toBool(md.email_enabled),
      meta: toBool(md.meta_enabled),
      voice: toBool(md.voice_enabled),
    };

    FEATURES_CACHE[key] = { exp: Date.now() + TTL_MS, features };
    return features;
  } catch (err) {
    console.error("[channel-settings] Stripe fetch error(product):", err);
    // fallback seguro (conservador)
    const fallback: Partial<Record<Canal, boolean>> = {
      whatsapp: true,
      sms: false,
      email: false,
      meta: false,
      voice: false,
    };
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

    // 3) Plan del tenant + extras + plan_limits (para fallback robusto)
    const { rows } = await pool.query(
      `SELECT plan, es_trial, trial_ends_at, plan_after_trial, extra_features, plan_limits
       FROM tenants
       WHERE id = $1`,
      [tenant_id]
    );

    const tenant = rows[0] || {};
    const { planName, trialActive } = resolveEffectivePlan(tenant);

    // extra_features (puede ser null)
    const extra = (tenant.extra_features as any) || {};

    // ✅ Intentar resolver el Stripe Product ID
    // 1) Preferido: extra_features.stripe_product_id
    const stripeProductId =
      typeof extra?.stripe_product_id === "string" ? extra.stripe_product_id.trim() : "";

    // 2) Si el "plan" ya viene siendo un product id (prod_...), úsalo (por compat)
    const planLooksLikeProductId = planName.startsWith("prod_") ? planName : "";

    // prioridad: stripeProductId > planLooksLikeProductId
    const productIdToUse = stripeProductId || planLooksLikeProductId;

    // 4) Features del plan desde Stripe POR PRODUCT ID
    let planFeatures: Partial<Record<Canal, boolean>>;

    if (productIdToUse) {
      planFeatures = await getFeaturesFromStripeByProductId(productIdToUse);
    } else {
      // ✅ Fallback: usa plan_limits si existe (tu DB lo tiene)
      const limits = (tenant.plan_limits as any) || {};
      planFeatures = {
        whatsapp: Number(limits?.whatsapp ?? 0) > 0,
        sms: Number(limits?.sms ?? 0) > 0,
        email: Number(limits?.email ?? 0) > 0,
        meta: Number(limits?.meta ?? 0) > 0,
        // voz puede estar como "voz" en tu JSON
        voice: Number(limits?.voz ?? limits?.voice ?? 0) > 0,
      };
    }

    // Por defecto, lo que diga Stripe/plan_limits
    // (para google_calendar lo dejamos true por ahora)
    const enabledByPlan = canal === "google_calendar" ? true : !!planFeatures[canal];

    // ✅ Override manual por tenant (admin)
    // Nota: para google_calendar soportamos force_google_calendar si quieres usarlo luego
    const enabledByOverride = extra?.[`force_${canal}`] === true;

    // ✅ Resultado final: plan OR override
    const enabledEffective = enabledByPlan || enabledByOverride;

    // 5) Gate final
    const enabled = enabledEffective && settingsEnabled && !maint.maintenance;

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      canal,
      enabled,
      plan_enabled: enabledEffective, // ✅ effective, no solo Stripe
      settings_enabled: settingsEnabled,
      maintenance: maint.maintenance,
      maintenance_message: maint.message,
      maintenance_window:
        maint.starts_at || maint.ends_at
          ? { starts_at: maint.starts_at, ends_at: maint.ends_at }
          : null,
      plan_current: planName,
      trial_active: trialActive,
      trial_ends_at: tenant.trial_ends_at || null,

      // ✅ útil para debug (puedes borrar luego si quieres)
      product_id_used: productIdToUse || null,
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
