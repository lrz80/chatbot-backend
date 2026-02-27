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

  // ✅ reales en tu DB
  mensaje_nivel_bajo?: string | null;
  mensaje_nivel_medio?: string | null;
  mensaje_nivel_alto?: string | null;

  // legacy
  mensaje_precio?: string | null;
  mensaje_agendar?: string | null;
  mensaje_ubicacion?: string | null;
  mensaje_general?: string | null;
};

// ✅ Intenciones GENÉRICAS que sí justifican follow-up (multitenant, nada hardcode por negocio)
const FOLLOWUP_ELIGIBLE_INTENTS = new Set<string>([
  "interes",
  "precio",
  "cotizacion",
  "agendar",
  "reserva",
  "compra",
  "membresia",
  "plan",
  "paquete",
]);

function clampLevel(level?: number | null): 1 | 2 | 3 {
  const n = typeof level === "number" ? level : 2;
  if (n <= 1) return 1;
  if (n >= 3) return 3;
  return 2;
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
  const bajo  = (settings.mensaje_nivel_bajo  || "").trim();
  const medio = (settings.mensaje_nivel_medio || "").trim();
  const alto  = (settings.mensaje_nivel_alto  || "").trim();

  const picked = level === 1 ? bajo : level === 2 ? medio : alto;
  if (picked) return picked;

  // fallback legacy temporal
  const legacyPrecio = (settings.mensaje_precio || "").trim();
  const legacyGeneral = (settings.mensaje_general || "").trim();

  if (level === 3 && legacyPrecio) return legacyPrecio;
  if (legacyGeneral) return legacyGeneral;

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
     )
     ON CONFLICT (tenant_id, canal, contacto)
     DO UPDATE SET
       contenido = EXCLUDED.contenido,
       fecha_envio = EXCLUDED.fecha_envio,
       enviado = FALSE,
       sent_at = NULL`,
    [tenantId, canal, contacto, contenido, String(delayMinutes)]
  );
}

/**
 * ✅ API pública: un solo follow-up (NO secuencias) con delay según nivel.
 *
 * Comportamiento:
 * - Respeta flag skip.
 * - Ignora canal "preview".
 * - Solo programa follow-up si:
 *   - hay tenant.id y contacto,
 *   - la intención es elegible (venta),
 *   - nivel de interés >= 2,
 *   - hay settings + plantilla en DB.
 */
export async function scheduleFollowUpIfEligible(opts: {
  tenant: any;
  canal: FollowUpChannel;
  contactoNorm: string;
  idiomaDestino: "es" | "en";   // por si luego quieres plantillas por idioma
  intFinal?: string | null;     // intención final (para debug/analytics)
  nivel?: number | null;        // nivel de interés detectado
  userText: string;
  skip?: boolean;               // si es true, no programa nada
}): Promise<{
  scheduled: boolean;
  reason:
    | "skip_flag"
    | "invalid_tenant"
    | "invalid_contact"
    | "preview_channel"
    | "no_intent"
    | "intent_not_eligible"
    | "interest_too_low"
    | "no_settings"
    | "no_template"
    | "scheduled";
  level?: 1 | 2 | 3;
}> {
  const {
    tenant,
    canal,
    contactoNorm,
    intFinal,
    nivel,
    userText,
    skip,
  } = opts;

  // ✅ Respeta flag skip
  if (skip) {
    console.log("[FOLLOWUP] skipped: skip_flag", {
      canal,
      contactoNorm,
      intFinal,
      nivel,
      userText,
    });
    return { scheduled: false, reason: "skip_flag" };
  }

  if (!tenant?.id) {
    return { scheduled: false, reason: "invalid_tenant" };
  }

  if (!contactoNorm || !String(contactoNorm).trim()) {
    return { scheduled: false, reason: "invalid_contact" };
  }

  // nunca en preview
  if (canal === "preview") {
    console.log("[FOLLOWUP] skipped: preview_channel", {
      canal,
      contactoNorm,
      intFinal,
    });
    return { scheduled: false, reason: "preview_channel" };
  }

  // ✅ normalizar nivel de interés
  const nivelInteres = typeof nivel === "number" ? nivel : 0;

  // ✅ 1) Sin intención -> no hay follow-up
  if (!intFinal) {
    console.log("[FOLLOWUP] skipped: no_intent", {
      canal,
      contactoNorm,
      nivelInteres,
      userText,
    });
    return { scheduled: false, reason: "no_intent" };
  }

  // ✅ 2) Intención debe ser elegible (venta)
  if (!FOLLOWUP_ELIGIBLE_INTENTS.has(intFinal)) {
    console.log("[FOLLOWUP] skipped: intent_not_eligible", {
      intFinal,
      canal,
      contactoNorm,
      nivelInteres,
    });
    return { scheduled: false, reason: "intent_not_eligible" };
  }

  // ✅ 3) Nivel de interés mínimo
  if (nivelInteres < 2) {
    console.log("[FOLLOWUP] skipped: interest_too_low", {
      intFinal,
      canal,
      contactoNorm,
      nivelInteres,
    });
    return { scheduled: false, reason: "interest_too_low" };
  }

  // A partir de aquí, SÍ queremos programar algo
  const level = clampLevel(nivelInteres);

  const settings = await getFollowUpSettings(tenant.id);
  if (!settings) {
    console.log("[FOLLOWUP] skipped: no_settings", {
      tenantId: tenant.id,
      intFinal,
      level,
    });
    return { scheduled: false, reason: "no_settings", level };
  }

  const template = pickTemplateByLevel(settings, level);
  if (!template) {
    console.log("[FOLLOWUP] skipped: no_template", {
      tenantId: tenant.id,
      intFinal,
      level,
    });
    return { scheduled: false, reason: "no_template", level };
  }

  // 🕒 minutos_espera en DB se interpreta como delay FINAL en MINUTOS
  const delayMinutes = Math.max(1, Number(settings.minutos_espera || 60));

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

  console.log("[FOLLOWUP] scheduled OK", {
    tenantId: tenant.id,
    canal,
    contactoNorm,
    intFinal,
    nivelInteres,
    level,
    delayMinutes,
  });

  return { scheduled: true, reason: "scheduled", level };
}