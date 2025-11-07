import pool from "../lib/db";

export async function getMaintenance(
  canal: "sms"|"email"|"whatsapp"|"meta"|"voice",
  tenantId?: string
) {
  const { rows } = await pool.query(
    `
    WITH pick AS (
      -- 1️⃣ preferente por tenant
      SELECT cm.*
      FROM channel_maintenance cm
      WHERE cm.canal = $1 AND cm.tenant_id = $2
      UNION ALL
      -- 2️⃣ fallback global
      SELECT cm.*
      FROM channel_maintenance cm
      WHERE cm.canal = $1 AND cm.tenant_id IS NULL
      LIMIT 1
    )
    SELECT
      COALESCE(maintenance, false) AS maintenance,
      message,
      starts_at,
      ends_at
    FROM pick
    LIMIT 1
    `,
    [canal, tenantId || null]
  );

  const r = rows[0] || {};
  const now = new Date();

  const inWindow =
    (!r.starts_at || new Date(r.starts_at) <= now) &&
    (!r.ends_at   || new Date(r.ends_at)   >= now);

  const active = !!r.maintenance && inWindow;

  return {
    maintenance: active,
    message: r.message || null,
    starts_at: r.starts_at || null,
    ends_at: r.ends_at || null,
  };
}

export async function getChannelEnabledBySettings(
  tenantId: string,
  canal: "sms"|"email"|"whatsapp"|"meta"|"voice"
) {
  const { rows } = await pool.query(
    `SELECT whatsapp_enabled, sms_enabled, email_enabled, meta_enabled, voice_enabled
     FROM channel_settings WHERE tenant_id = $1 LIMIT 1`,
    [tenantId]
  );
  const flags = rows[0] || {};
  const map = {
    whatsapp: !!flags.whatsapp_enabled,
    sms:      !!flags.sms_enabled,
    email:    !!flags.email_enabled,
    meta:     !!flags.meta_enabled,
    voice:    !!flags.voice_enabled,
  };
  return map[canal] ?? false;
}
