// src/lib/followups/followUpScheduler.ts

import pool from "../db";
import type { LangCode } from "../i18n/lang";

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

// ✅ Intenciones típicas “de venta” (se mantienen como señal, pero ya no bloquean)
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
  "info_servicio",
  "info_general",
  "info_general_overview",
  "pago",
]);

// ✅ Intenciones genéricas donde NO debes dar follow-up (multi-tenant)
const FOLLOWUP_BLOCKED_INTENTS = new Set<string>([
  "no_interesado",
  "sin_interes",
  "stop",
  "unsubscribe",
  "cancelar_suscripcion",
  "wrong_number",
  "numero_equivocado",
  "spam",
  "catalog_disambiguation",
  "price_disambiguation",
  "clarification",
  "unknown",
]);

function clampLevel(level?: number | null): 1 | 2 | 3 {
  const n = typeof level === "number" ? level : 2;
  if (n <= 1) return 1;
  if (n >= 3) return 3;
  return 2;
}

async function getFollowUpSettings(
  tenantId: string
): Promise<FollowUpSettingsRow | null> {
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

function pickTemplateByLevel(
  settings: FollowUpSettingsRow,
  level: 1 | 2 | 3
): string | null {
  const bajo = (settings.mensaje_nivel_bajo || "").trim();
  const medio = (settings.mensaje_nivel_medio || "").trim();
  const alto = (settings.mensaje_nivel_alto || "").trim();

  const picked = level === 1 ? bajo : level === 2 ? medio : alto;
  if (picked) return picked;

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

function shouldScheduleFollowUp(args: {
  intFinal?: string | null;
  nivelInteres: number;
}): {
  ok: boolean;
  reason: "no_intent" | "intent_blocked" | "interest_too_low" | "ok";
} {
  const normalizedIntent = String(args.intFinal || "").trim().toLowerCase();
  const { nivelInteres } = args;

  if (!normalizedIntent) {
    return { ok: false, reason: "no_intent" };
  }

  if (FOLLOWUP_BLOCKED_INTENTS.has(normalizedIntent)) {
    return { ok: false, reason: "intent_blocked" };
  }

  if (nivelInteres < 2) {
    return { ok: false, reason: "interest_too_low" };
  }

  return { ok: true, reason: "ok" };
}

/**
 * ✅ API pública: un solo follow-up (NO secuencias) con delay según nivel.
 */
export async function scheduleFollowUpIfEligible(opts: {
  tenant: any;
  canal: FollowUpChannel;
  contactoNorm: string;
  idiomaDestino: LangCode;
  intFinal?: string | null;
  nivel?: number | null;
  userText: string;
  skip?: boolean;
  estadoCliente?: string | null;
}): Promise<{
  scheduled: boolean;
  reason:
    | "skip_flag"
    | "invalid_tenant"
    | "invalid_contact"
    | "preview_channel"
    | "no_intent"
    | "intent_blocked"
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
    estadoCliente,
  } = opts;

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

  if (canal === "preview") {
    console.log("[FOLLOWUP] skipped: preview_channel", {
      canal,
      contactoNorm,
      intFinal,
    });
    return { scheduled: false, reason: "preview_channel" };
  }

  const nivelInteres = typeof nivel === "number" ? nivel : 0;

  const gate = shouldScheduleFollowUp({ intFinal, nivelInteres });
  if (!gate.ok) {
    const reason =
      gate.reason === "no_intent"
        ? "no_intent"
        : gate.reason === "intent_blocked"
        ? "intent_blocked"
        : "interest_too_low";

    console.log("[FOLLOWUP] skipped:", reason, {
      intFinal,
      canal,
      contactoNorm,
      nivelInteres,
      estadoCliente,
      isSalesLikeIntent: intFinal
        ? FOLLOWUP_ELIGIBLE_INTENTS.has(String(intFinal).trim().toLowerCase())
        : false,
    });

    return { scheduled: false, reason };
  }

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

  const delayMinutes = Math.max(1, Number(settings.minutos_espera || 60));

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
    estadoCliente,
    isSalesLikeIntent: intFinal
      ? FOLLOWUP_ELIGIBLE_INTENTS.has(String(intFinal).trim().toLowerCase())
      : false,
  });

  return { scheduled: true, reason: "scheduled", level };
}