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
  // ✅ Un solo follow-up; delay “según nivel”
  // Ajusta si quieres: 1=base, 2=base*2, 3=base*3
  const { baseMinutes, interestLevel } = opts;
  return Math.max(1, Math.round(baseMinutes * interestLevel));
}

async function getFollowUpSettings(tenantId: string): Promise<FollowUpSettingsRow | null> {
  // Si solo tienes por-tenant, esto basta.
  // Si manejas un GLOBAL_ID fallback, aquí puedes hacer COALESCE.
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
  // ✅ nuevo esquema
  const n1 = (settings.mensaje_nivel_1 || "").trim();
  const n2 = (settings.mensaje_nivel_2 || "").trim();
  const n3 = (settings.mensaje_nivel_3 || "").trim();

  const picked =
    level === 1 ? n1 :
    level === 2 ? n2 :
    n3;

  if (picked) return picked;

  // 🔁 fallback legacy para no romper producción mientras migras UI/DB:
  // - nivel 3 ~ precio
  // - nivel 2 ~ general
  // - nivel 1 ~ general (o agendar si así lo prefieres)
  const legacyPrecio = (settings.mensaje_precio || "").trim();
  const legacyGeneral = (settings.mensaje_general || "").trim();
  const legacyAgendar = (settings.mensaje_agendar || "").trim();

  if (level === 3 && legacyPrecio) return legacyPrecio;
  if (legacyGeneral) return legacyGeneral;
  if (legacyAgendar) return legacyAgendar;

  return null;
}

async function hasPendingFollowUp(opts: {
  tenantId: string;
  canal: string;
  contacto: string;
}): Promise<boolean> {
  const { tenantId, canal, contacto } = opts;

  const { rows } = await pool.query(
    `SELECT 1
       FROM mensajes_programados
      WHERE tenant_id = $1
        AND canal = $2
        AND contacto = $3
        AND enviado = FALSE
        AND fecha_envio > NOW()
      LIMIT 1`,
    [tenantId, canal, contacto]
  );

  return rows.length > 0;
}

async function insertScheduledMessage(opts: {
  tenantId: string;
  canal: string;
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
 * No usa “precio/agendar/ubicación/general”.
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

  // si quieres bloquear por membresía, habilítalo:
  // const active =
  //   tenant.membresia_activa === true ||
  //   tenant.membresia_activa === "true" ||
  //   tenant.membresia_activa === 1;
  // if (!active) return;

  const level = clampLevel(nivel);

  const settings = await getFollowUpSettings(tenant.id);
  if (!settings) return;

  // ✅ 1 follow-up pendiente máximo por contacto/canal
  const pending = await hasPendingFollowUp({
    tenantId: tenant.id,
    canal,
    contacto: contactoNorm,
  });
  if (pending) return;

  const template = pickTemplateByLevel(settings, level);
  if (!template) return;

  // ✅ baseMinutes viene de DB; si UI pone 1-23 hrs, debes convertir a minutos al guardar.
  const baseMinutes = Math.max(1, Number(settings.minutos_espera || 60));

  const delayMinutes = computeDelayMinutes({
    baseMinutes,
    interestLevel: level,
  });

  await insertScheduledMessage({
    tenantId: tenant.id,
    canal,
    contacto: contactoNorm,
    contenido: template,
    delayMinutes,
  });
}
