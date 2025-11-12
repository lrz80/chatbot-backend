import pool from "../lib/db";

type Features = {
  whatsapp_enabled: boolean;
  meta_enabled: boolean;
  voice_enabled: boolean;
  sms_enabled: boolean;
  email_enabled: boolean;
  paused_until: string | Date | null;
  paused_until_whatsapp: string | Date | null;
  paused_until_meta: string | Date | null;
  paused_until_voice: string | Date | null;
  paused_until_sms: string | Date | null;
  paused_until_email: string | Date | null;
  [k: string]: any;
};

const GLOBAL_TENANT_ID = "00000000-0000-0000-0000-000000000001";

// UUID simple (suficiente para evitar 22P02)
const isUUID = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);

const EMPTY: Features = {
  whatsapp_enabled: false,
  meta_enabled: false,
  voice_enabled: false,
  sms_enabled: false,
  email_enabled: false,
  paused_until: null,
  paused_until_whatsapp: null,
  paused_until_meta: null,
  paused_until_voice: null,
  paused_until_sms: null,
  paused_until_email: null,
};

export async function getFeatures(tenantId: string): Promise<Features> {
  if (!tenantId || !isUUID(tenantId)) return { ...EMPTY };

  const { rows } = await pool.query(
    `
    SELECT
      tenant_id,
      COALESCE(whatsapp_enabled,false)  AS whatsapp_enabled,
      COALESCE(meta_enabled,false)      AS meta_enabled,
      COALESCE(voice_enabled,false)     AS voice_enabled,
      COALESCE(sms_enabled,false)       AS sms_enabled,
      COALESCE(email_enabled,false)     AS email_enabled,
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

  if (!rows?.length) return { ...EMPTY };

  // Mezcla: primero global, luego tenant sobreescribe
  const ordered = rows.length === 2 ? [rows[1], rows[0]] : rows;

  const out: Features = { ...EMPTY };
  for (const r of ordered) {
    out.whatsapp_enabled       = !!r.whatsapp_enabled;
    out.meta_enabled           = !!r.meta_enabled;
    out.voice_enabled          = !!r.voice_enabled;
    out.sms_enabled            = !!r.sms_enabled;
    out.email_enabled          = !!r.email_enabled;
    out.paused_until           = r.paused_until ?? out.paused_until;
    out.paused_until_whatsapp  = r.paused_until_whatsapp ?? out.paused_until_whatsapp;
    out.paused_until_meta      = r.paused_until_meta ?? out.paused_until_meta;
    out.paused_until_voice     = r.paused_until_voice ?? out.paused_until_voice;
    out.paused_until_sms       = r.paused_until_sms ?? out.paused_until_sms;
    out.paused_until_email     = r.paused_until_email ?? out.paused_until_email;
  }

  return out;
}

export function isPaused(dateLike?: string | Date | null): boolean {
  if (!dateLike) return false;
  const d = typeof dateLike === "string" ? new Date(dateLike) : dateLike;
  const t = d?.getTime?.();
  if (!Number.isFinite(t)) return false;
  return t! > Date.now(); // si la fecha es futura, sigue en pausa
}
