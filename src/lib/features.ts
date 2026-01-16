// src/lib/features.ts
import pool from "../lib/db";

export type Canal = "whatsapp" | "meta" | "voice" | "sms" | "email" | "google_calendar";

type Features = {
  // ← SETTINGS (channel_settings por-tenant y/o global)
  settings: {
    whatsapp_enabled: boolean;
    meta_enabled: boolean;
    voice_enabled: boolean;
    sms_enabled: boolean;
    email_enabled: boolean;
    google_calendar_enabled: boolean;
    paused_until: Date | null;
    paused_until_whatsapp: Date | null;
    paused_until_meta: Date | null;
    paused_until_voice: Date | null;
    paused_until_sms: Date | null;
    paused_until_email: Date | null;
  };
  // ← PLAN (lo que el plan permite)
  plan: {
    whatsapp_enabled: boolean;
    meta_enabled: boolean;
    voice_enabled: boolean;
    sms_enabled: boolean;
    email_enabled: boolean;
    source: "tenant_plan_features" | "tenants.plan" | "default";
    product_id?: string | null;
    plan_name?: string | null;
  };
};

const GLOBAL_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const isUUID = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);

const EMPTY_SETTINGS: Features["settings"] = {
  whatsapp_enabled: false,
  meta_enabled: false,
  voice_enabled: false,
  sms_enabled: false,
  email_enabled: false,
  google_calendar_enabled: false,
  paused_until: null,
  paused_until_whatsapp: null,
  paused_until_meta: null,
  paused_until_voice: null,
  paused_until_sms: null,
  paused_until_email: null,
};

const EMPTY_PLAN: Features["plan"] = {
  whatsapp_enabled: true,  // por defecto permitimos WhatsApp
  meta_enabled: false,
  voice_enabled: false,
  sms_enabled: false,
  email_enabled: false,
  source: "default",
  product_id: null,
  plan_name: null,
};

// -------- Helpers
export function isPaused(dateLike?: string | Date | null): boolean {
  if (!dateLike) return false;
  const d = typeof dateLike === "string" ? new Date(dateLike) : dateLike;
  const t = d?.getTime?.();
  if (!Number.isFinite(t)) return false;
  return t! > Date.now(); // si es futura, sigue en pausa
}

function pausedFor(c: Canal, s: Features["settings"]) {
  if (isPaused(s.paused_until)) return true;
  if (c === "whatsapp") return isPaused(s.paused_until_whatsapp);
  if (c === "meta") return isPaused(s.paused_until_meta);
  if (c === "voice") return isPaused(s.paused_until_voice);
  if (c === "sms") return isPaused(s.paused_until_sms);
  if (c === "email") return isPaused(s.paused_until_email);
  return false;
}

// -------- Carga SETTINGS (channel_settings global + tenant)
async function loadSettings(tenantId: string): Promise<Features["settings"]> {
  if (!tenantId || !isUUID(tenantId)) return { ...EMPTY_SETTINGS };

  const { rows } = await pool.query(
    `
    SELECT
      tenant_id,
      COALESCE(whatsapp_enabled,false)  AS whatsapp_enabled,
      COALESCE(meta_enabled,false)      AS meta_enabled,
      COALESCE(voice_enabled,false)     AS voice_enabled,
      COALESCE(sms_enabled,false)       AS sms_enabled,
      COALESCE(email_enabled,false)     AS email_enabled,
      COALESCE(google_calendar_enabled,false) AS google_calendar_enabled,
      paused_until,
      paused_until_whatsapp,
      paused_until_meta,
      paused_until_voice,
      paused_until_sms,
      paused_until_email
    FROM channel_settings
    WHERE tenant_id = $1 OR tenant_id = $2
    ORDER BY (tenant_id = $1) DESC
    LIMIT 2
    `,
    [tenantId, GLOBAL_TENANT_ID]
  );

  if (!rows?.length) return { ...EMPTY_SETTINGS };

  // Primero global, luego tenant sobreescribe
  const ordered = rows.length === 2 ? [rows[1], rows[0]] : rows;

  const out = { ...EMPTY_SETTINGS };
  for (const r of ordered) {
    out.whatsapp_enabled      = !!r.whatsapp_enabled || out.whatsapp_enabled;
    out.meta_enabled          = !!r.meta_enabled     || out.meta_enabled;
    out.voice_enabled         = !!r.voice_enabled    || out.voice_enabled;
    out.sms_enabled           = !!r.sms_enabled      || out.sms_enabled;
    out.email_enabled         = !!r.email_enabled    || out.email_enabled;
    out.paused_until          = r.paused_until ?? out.paused_until;
    out.paused_until_whatsapp = r.paused_until_whatsapp ?? out.paused_until_whatsapp;
    out.paused_until_meta     = r.paused_until_meta ?? out.paused_until_meta;
    out.paused_until_voice    = r.paused_until_voice ?? out.paused_until_voice;
    out.paused_until_sms      = r.paused_until_sms ?? out.paused_until_sms;
    out.paused_until_email    = r.paused_until_email ?? out.paused_until_email;
    out.google_calendar_enabled = !!r.google_calendar_enabled || out.google_calendar_enabled;
  }
  return out;
}

async function tableExists(table: string): Promise<boolean> {
  const { rows } = await pool.query(
    `select to_regclass($1) as reg`,
    [`public.${table}`]
  );
  return !!rows[0]?.reg;
}

// -------- Carga PLAN (prioridad: tenant_plan_features → tenants.plan → default)
async function loadPlan(tenantId: string): Promise<Features["plan"]> {
  if (!tenantId || !/^[0-9a-f-]{36}$/i.test(tenantId)) return { ...EMPTY_PLAN };

  // 1) Cache por-tenant sincronizada desde Stripe (solo si la tabla existe)
  try {
    if (await tableExists("tenant_plan_features")) {
      const q1 = await pool.query(
        `select product_id, 
                coalesce(whatsapp_enabled,false) as whatsapp_enabled,
                coalesce(meta_enabled,false)     as meta_enabled,
                coalesce(voice_enabled,false)    as voice_enabled,
                coalesce(sms_enabled,false)      as sms_enabled,
                coalesce(email_enabled,false)    as email_enabled
         from tenant_plan_features
         where tenant_id = $1
         limit 1`,
        [tenantId]
      );
      if (q1.rows[0]) {
        const r = q1.rows[0];
        return {
          whatsapp_enabled: !!r.whatsapp_enabled,
          meta_enabled: !!r.meta_enabled,
          voice_enabled: !!r.voice_enabled,
          sms_enabled: !!r.sms_enabled,
          email_enabled: !!r.email_enabled,
          source: "tenant_plan_features",
          product_id: r.product_id,
          plan_name: null,
        };
      }
    }
  } catch (_) {
    // silencioso: no logueamos para evitar ruido en DB logs
  }

  // 2) Fallback: usa plan guardado en tenants y mapea con ENV
  try {
    const q2 = await pool.query(
      `select plan as plan_name
         from tenants
        where id = $1
        limit 1`,
      [tenantId]
    );
    if (q2.rows[0]) {
      const { plan_name } = q2.rows[0];
      const plan = String(plan_name || "").toLowerCase();

      if (plan === "starter") {
        return {
          whatsapp_enabled: true,
          meta_enabled: false,
          voice_enabled: false,
          sms_enabled: false,
          email_enabled: false,
          source: "tenants.plan",
          product_id: process.env.STRIPE_PRODUCT_STARTER_ID || null,
          plan_name,
        };
      }
      if (plan === "pro") {
        return {
          whatsapp_enabled: true,
          meta_enabled: true,
          voice_enabled: true,
          sms_enabled: true,
          email_enabled: true,
          source: "tenants.plan",
          product_id: process.env.STRIPE_PRODUCT_PRO_ID || null,
          plan_name,
        };
      }
    }
  } catch (_) {}

  // 3) Default conservador
  return { ...EMPTY_PLAN };
}

// -------- API pública de este módulo
export async function getFeatures(tenantId: string): Promise<Features> {
  const [settings, plan] = await Promise.all([loadSettings(tenantId), loadPlan(tenantId)]);
  return { settings, plan };
}

/**
 * Gate unificado para un canal.
 * enabled = plan_enabled && settings_enabled && !paused
 * (si manejas "maintenance", añádelo aquí)
 */
export async function canUseChannel(
  tenantId: string,
  canal: Canal
): Promise<{
  enabled: boolean;
  reason: "plan" | "paused" | null;
  plan_enabled: boolean;
  settings_enabled: boolean;
  paused_until: Date | null;
}> {
  const f = await getFeatures(tenantId);

  // plan
  const plan_enabled =
    canal === "whatsapp" ? f.plan.whatsapp_enabled :
    canal === "meta"     ? f.plan.meta_enabled :
    canal === "voice"    ? f.plan.voice_enabled :
    canal === "sms"      ? f.plan.sms_enabled :
    canal === "email"    ? f.plan.email_enabled : false;
    canal === "google_calendar" ? true : false;

  // settings (toggle por-tenant / global)
  const settings_enabled =
    canal === "whatsapp" ? f.settings.whatsapp_enabled :
    canal === "meta"     ? f.settings.meta_enabled :
    canal === "voice"    ? f.settings.voice_enabled :
    canal === "sms"      ? f.settings.sms_enabled :
    canal === "email"    ? f.settings.email_enabled : false;
    canal === "google_calendar" ? f.settings.google_calendar_enabled : false;

  const paused =
    canal === "whatsapp" ? pausedFor("whatsapp", f.settings) :
    canal === "meta"     ? pausedFor("meta", f.settings) :
    canal === "voice"    ? pausedFor("voice", f.settings) :
    canal === "sms"      ? pausedFor("sms", f.settings) :
    canal === "email"    ? pausedFor("email", f.settings) : false;

  const enabled = plan_enabled && settings_enabled && !paused;

  return {
    enabled,
    reason: !plan_enabled ? "plan" : paused ? "paused" : null,
    plan_enabled,
    settings_enabled,
    paused_until:
      canal === "whatsapp" ? f.settings.paused_until_whatsapp :
      canal === "meta"     ? f.settings.paused_until_meta :
      canal === "voice"    ? f.settings.paused_until_voice :
      canal === "sms"      ? f.settings.paused_until_sms :
      canal === "email"    ? f.settings.paused_until_email :
      null,
  };
}
