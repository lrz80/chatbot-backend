import pool from "../lib/db";

/**
 * Estructura esperada en channel_settings:
 * tenant_id (PK)
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
  paused_until?: Date | null;
  paused_until_whatsapp?: Date | null;
  paused_until_meta?: Date | null;
  paused_until_voice?: Date | null;
  paused_until_sms?: Date | null;
  paused_until_email?: Date | null;
  // Permite más campos a futuro
  [k: string]: any;
};

export async function getFeatures(tenantId: string): Promise<Features> {
  // Lee fila global y fila del tenant en una sola consulta
  const { rows } = await pool.query(
    `
    SELECT *
    FROM channel_settings
    WHERE tenant_id = ANY($1)
  `,
    [[ "global", tenantId ]]
  );

  // Mezcla: global primero, luego tenant sobreescribe
  const base: Features = {};
  for (const r of rows) {
    for (const key in r) {
      if (key === "tenant_id" || key === "created_at" || key === "updated_at") continue;
      base[key] = r[key];
    }
  }
  return base;
}

export function isPaused(dateLike?: string | Date | null): boolean {
  if (!dateLike) return false;
  const t = typeof dateLike === "string" ? new Date(dateLike) : dateLike;
  if (Number.isNaN(t.getTime())) return false;
  return t.getTime() > Date.now(); // si la fecha es futura, sigue en pausa
}
