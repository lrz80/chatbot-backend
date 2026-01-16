// src/lib/followups/followUpScheduler.ts

import pool from "../db";

export type FollowUpChannel =
  | "whatsapp"
  | "facebook"
  | "instagram"
  | "sms"
  | "meta"
  | "voz"
  | "preview";

type FollowUpSettingsRow = {
  id: string;
  tenant_id: string;
  minutos_espera: number | null;

  // ✅ nuevos (por niveles)
  mensaje_nivel_1?: string | null;
  mensaje_nivel_2?: string | null;
  mensaje_nivel_3?: string | null;

  // legacy (por si aún existe en DB)
  mensaje_precio?: string | null;
  mensaje_agendar?: string | null;
  mensaje_ubicacion?: string | null;
  mensaje_general?: string | null;
};

function clampLevel(level?: number | null): 1 | 2 | 3 {
  const n = typeof level === "number" ? level : 2;
  if (n <= 1) return 1;
  if (n >= 3) return 3;
  return 2;
}

function computeDelayMinutes(opts: {
  baseMinutes: number;
  interestLevel: 1 | 2 | 3;
}): number {
  // 1=base, 2=base*2, 3=base*3
  const { baseMinutes, interestLevel } = opts;
  return Math.max(1, Math.round(baseMinutes * interestLevel));
}

async function getFollowUpSettings(tenantId: string): Promise<FollowUpSettingsRow | null> {
  try {
    const { rows } = await pool.query(
      `SELECT *
         FROM follow_up_settings
        WHERE tenant_id = $1
        LIMIT 1`,
      [tenantId]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

function pickTemplateByLevel(settings: FollowUpSettingsRow, level: 1 | 2 | 3): string | null {
  const n1 = (settings.mensaje_nivel_1 || "").trim();
  const n2 = (settings.mensaje_nivel_2 || "").trim();
  const n3 = (settings.mensaje_nivel_3 || "").trim();

  const picked = level === 1 ? n1 : level === 2 ? n2 : n3;
  if (picked) return picked;

  // 🔁 fallback legacy mientras migras:
  const legacyPrecio = (settings.mensaje_precio || "").trim();
  const legacyGeneral = (settings.mensaje_general || "").trim();
  const legacyAgendar = (settings.mensaje_agendar || "").trim();

  if (level === 3 && legacyPrecio) return legacyPrecio;
  if (legacyGeneral) return legacyGeneral;
  if (legacyAgendar) return legacyAgendar;

  return null;
}

/**
 * ✅ Cancela (elimina) follow-ups pendientes de este contacto antes de reprogramar.
 * Solo borra los que aún NO se han enviado y todavía no vencen (fecha_envio > NOW()).
 */
export async function cancelPendingFollowUps(opts: {
  tenantId: string;
  canal: FollowUpChannel;
  contacto: string;
}): Promise<number> {
  const { tenantId, canal, contacto } = opts;

  const { rowCount } = await pool.query(
    `DELETE FROM mensajes_programados
      WHERE tenant_id = $1
        AND canal = $2
        AND contacto = $3
        AND enviado = FALSE
        AND fecha_envio > NOW()`,
    [tenantId, canal, contacto]
  );

  return rowCount || 0;
}

async function insertScheduledMessage(opts: {
  tenantId: string;
  canal: FollowUpChannel;
  contacto: string;
  contenido: string;
  delayMinutes: number;
}): Promise<void> {
  const { tenantId, canal, contacto, contenido, delayMinutes } = opts;

  await pool.query(
    `INSERT INTO mensajes_programados (
        tenant_id, canal, contacto, contenido, fecha_envio, enviado, sent_at
     )
     VALUES (
        $1, $2, $3, $4, NOW() + ($5 || ' minutes')::interval, FALSE, NULL
     )`,
    [tenantId, canal, contacto, contenido, String(delayMinutes)]
  );
}

/**
 * ✅ API pública: un solo follow-up (NO secuencias) con delay según nivel.
 *
 * NUEVO comportamiento:
 * - Si existe follow-up pendiente, lo elimina y reprograma uno nuevo.
 * - Esto permite: “si el cliente vuelve a escribir, resetear el follow-up”.
 */
export async function scheduleFollowUpIfEligible(opts: {
  tenant: any;
  canal: FollowUpChannel;
  contactoNorm: string;
  idiomaDestino: "es" | "en";   // queda por si luego quieres plantillas por idioma
  intFinal: string | null;      // ya NO decide plantilla (solo debug/analytics)
  nivel: number | null;         // ✅ esto decide el mensaje
  userText: string;
}): Promise<void> {
  const { tenant, canal, contactoNorm, nivel } = opts;

  if (!tenant?.id) return;
  if (!contactoNorm || !String(contactoNorm).trim()) return;

  // nunca en preview
  if (canal === "preview") return;

  const level = clampLevel(nivel);

  const settings = await getFollowUpSettings(tenant.id);
  if (!settings) return;

  const template = pickTemplateByLevel(settings, level);
  if (!template) return;

  // ✅ baseMinutes viene de DB; si tu UI configura 1–23 horas,
  // asegúrate de guardar minutos_espera en minutos (horas*60) en el endpoint.
  const baseMinutes = Math.max(1, Number(settings.minutos_espera || 60));

  const delayMinutes = computeDelayMinutes({
    baseMinutes,
    interestLevel: level,
  });

  // ✅ clave: borrar pending antes de reprogramar
  await cancelPendingFollowUps({
    tenantId: tenant.id,
    canal,
    contacto: contactoNorm,
  });

  await insertScheduledMessage({
    tenantId: tenant.id,
    canal,
    contacto: contactoNorm,
    contenido: template,
    delayMinutes,
  });
}
