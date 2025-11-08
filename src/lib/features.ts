import pool from "../lib/db";

/**
 * Estructura esperada en channel_settings:
 * tenant_id (UUID, PK)
 * whatsapp_enabled, meta_enabled, voice_enabled, sms_enabled, email_enabled (boolean)
 * paused_until_whatsapp, paused_until_meta, paused_until_voice, paused_until_sms, paused_until_email (timestamp null)
 * paused_until (timestamp null)  // pausa global opcional
 */
type Features = {
  whatsapp_enabled?: boolean;
  meta_enabled?: boolean;
  voice_enabled?: boolean;
  sms_enabled?: boolean;
  email_enabled?: boolean;
  paused_until?: string | Date | null;
  paused_until_whatsapp?: string | Date | null;
  paused_until_meta?: string | Date | null;
  paused_until_voice?: string | Date | null;
  paused_until_sms?: string | Date | null;
  paused_until_email?: string | Date | null;
  [k: string]: any;
};

const GLOBAL_TENANT_ID = "00000000-0000-0000-0000-000000000001";

/**
 * Lee flags combinando registro del tenant + registro global.
 * Prioridad: tenant > global. Sin strings "global" (evita 22P02).
 */
export async function getFeatures(tenantId: string): Promise<Features> {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM channel_settings
    WHERE tenant_id = $1
       OR tenant_id = $2
    ORDER BY (tenant_id = $1) DESC
    LIMIT 2
    `,
    [tenantId, GLOBAL_TENANT_ID]
  );

  // rows[0] = preferentemente tenant; rows[1] = global (si existe)
  const out: Features = {};
  // Mezcla en orden: primero global, luego tenant sobreescribe
  const sorted = rows.length === 2 ? [rows[1], rows[0]] : rows;
  for (const r of sorted) {
    for (const key in r) {
      if (key === "tenant_id" || key === "created_at" || key === "updated_at") continue;
      (out as any)[key] = (r as any)[key];
    }
  }
  return out;
}

export function isPaused(dateLike?: string | Date | null): boolean {
  if (!dateLike) return false;
  const d = typeof dateLike === "string" ? new Date(dateLike) : dateLike;
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() > Date.now(); // si la fecha es futura, sigue en pausa
}
