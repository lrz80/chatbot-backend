// backend/src/routes/webhook/whatsapp.ts

import { Router, Request, Response } from 'express';
import pool from '../../lib/db';
import twilio from 'twilio';
import { getPromptPorCanal, getBienvenidaPorCanal } from '../../lib/getPromptPorCanal';
import { detectarIdioma } from '../../lib/detectarIdioma';
import { enviarWhatsApp } from "../../lib/senders/whatsapp";

// ⬇️ Importa también esIntencionDeVenta para contar ventas correctamente
import { detectarIntencion, esIntencionDeVenta } from '../../lib/detectarIntencion';

import type { Canal } from '../../lib/detectarIntencion';
import { antiPhishingGuard } from "../../lib/security/antiPhishing";
import { saludoPuroRegex } from '../../lib/saludosConversacionales';
import { answerWithPromptBase } from '../../lib/answers/answerWithPromptBase';
import { getIO } from '../../lib/socket';
import { incrementarUsoPorCanal } from '../../lib/incrementUsage';
import { rememberTurn } from "../../lib/memory/rememberTurn";
import { rememberFacts } from "../../lib/memory/rememberFacts";
import { getMemoryValue } from "../../lib/clientMemory";
import { refreshFactsSummary } from "../../lib/memory/refreshFactsSummary";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  setConversationState as setConversationStateDB,
  getOrInitConversationState,
} from "../../lib/conversationState";
import { finalizeReply as finalizeReplyLib } from "../../lib/conversation/finalizeReply";
import { whatsappModeMembershipGuard } from "../../lib/guards/whatsappModeMembershipGuard";
import { paymentHumanGate } from "../../lib/guards/paymentHumanGuard";
import { yesNoStateGate } from "../../lib/guards/yesNoStateGate";
import { clearAwaitingState } from "../../lib/awaiting";
import { buildTurnContext } from "../../lib/conversation/buildTurnContext";
import { awaitingGate } from "../../lib/guards/awaitingGate";
import { createStateMachine } from "../../lib/conversation/stateMachine";
import { recordSalesIntent } from "../../lib/sales/recordSalesIntent";
import { detectarEmocion } from "../../lib/detectarEmocion";
import { applyEmotionTriggers } from "../../lib/guards/emotionTriggers";
import { scheduleFollowUpIfEligible, cancelPendingFollowUps } from "../../lib/followups/followUpScheduler";
import { bookingFlowMvp } from "../../lib/appointments/bookingFlow";
import crypto from "crypto";
import { sendCapiEvent } from "../../services/metaCapi";
import { isAmbiguousLangText } from "../../lib/appointments/booking/text";
import { runBookingGuardrail } from "../../lib/appointments/booking/guardrail";
import { wantsServiceLink } from "../../lib/services/wantsServiceLink";
import { resolveServiceLink } from "../../lib/services/resolveServiceLink";
import { wantsServiceInfo } from "../../lib/services/wantsServiceInfo";
import { resolveServiceInfo } from "../../lib/services/resolveServiceInfo";
import { renderServiceInfoReply } from "../../lib/services/renderServiceInfoReply";
import { wantsServiceList } from "../../lib/services/wantsServiceList";
import { resolveServiceList } from "../../lib/services/resolveServiceList";
import { renderServiceListReply } from "../../lib/services/renderServiceListReply";
import { humanOverrideGate } from "../../lib/guards/humanOverrideGate";
import { setHumanOverride } from "../../lib/humanOverride/setHumanOverride";
import { resolveThreadLang } from "../../lib/lang/threadLang";
import { getCustomerLangDB, upsertCustomerLangDB } from "../../lib/lang/customerLangStore";
import { saveConversationState } from "../../lib/conversation/saveConversationState";

const sha256 = (s: string) =>
  crypto.createHash("sha256").update(String(s || "").trim().toLowerCase()).digest("hex");

// ✅ DEDUPE 7 días (bucket estable). No depende de timezone.
function bucket7DaysUTC(d = new Date()) {
  const ms = d.getTime();
  const windowMs = 7 * 24 * 60 * 60 * 1000;
  return `b7:${Math.floor(ms / windowMs)}`;
}

// ✅ Reserva dedupe en DB usando interactions (ya tienes unique tenant+canal+message_id)
async function reserveCapiEvent(tenantId: string, eventId: string): Promise<boolean> {
  try {
    const r = await pool.query(
      `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
       VALUES ($1, 'meta_capi', $2, NOW())
       ON CONFLICT (tenant_id, canal, message_id) DO NOTHING
       RETURNING 1`,
      [tenantId, eventId]
    );
    return (r.rowCount ?? 0) > 0;
  } catch (e: any) {
    console.warn("⚠️ reserveCapiEvent failed:", e?.message);
    return false;
  }
}

// Puedes ponerlo debajo de los imports
export type WhatsAppContext = {
  tenant?: any;
  canal?: string;
  origen?: "twilio" | "meta";
};

// 💳 Confirmación de pago (usuario)
const PAGO_CONFIRM_REGEX =
  /^(?!.*\b(no|aun\s*no|todav[ií]a\s*no|not)\b).*?\b(pago\s*realizado|listo\s*el\s*pago|ya\s*pagu[eé]|he\s*paga(do|do)|payment\s*(done|made|completed)|i\s*paid|paid)\b/i;

// 🧾 Detectores básicos de datos
const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_REGEX = /(\+?\d[\d\s().-]{7,}\d)/;

function outboundId(messageId: string | null) {
  return messageId ? `${messageId}-out` : null;
}

function extractPaymentLinkFromPrompt(promptBase: string): string | null {
  if (!promptBase) return null;

  // 1) Preferido: marcador LINK_PAGO:
  const tagged = promptBase.match(/LINK_PAGO:\s*(https?:\/\/\S+)/i);
  if (tagged?.[1]) return tagged[1].replace(/[),.]+$/g, '');

  // 2) Fallback: primer URL
  const any = promptBase.match(/https?:\/\/[^\s)]+/i);
  return any?.[0] ? any[0].replace(/[),.]+$/g, '') : null;
}

function looksLikeBookingPayload(text: string) {
  const t = String(text || "");
  const hasEmail = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(t);
  const hasDateTime = /\b\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\b/.test(t);
  const hasDateOnly = /\b\d{4}-\d{2}-\d{2}\b/.test(t);
  const hasTimeOnly = /^\s*\d{2}:\d{2}\s*$/.test(t);
  return hasEmail || hasDateTime || hasDateOnly || hasTimeOnly;
}

function parsePickNumber(text: string): number | null {
  const t = String(text || "").trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return n;
}

function pickSelectedChannelFromText(
  text: string
): "whatsapp" | "instagram" | "facebook" | "multi" | null {
  const t = (text || "").trim().toLowerCase();

  if (/\b(los\s+tres|las\s+tres|todos|todas|all\s+three)\b/i.test(t)) {
    return "multi";
  }

  if (t === "whatsapp" || t === "wa") return "whatsapp";
  if (t === "instagram" || t === "ig") return "instagram";
  if (t === "facebook" || t === "fb") return "facebook";

  const hasWhats = /\bwhats(app)?\b/i.test(t);
  const hasInsta = /\binsta(gram)?\b/i.test(t);
  const hasFace  = /\b(face(book)?|fb)\b/i.test(t);

  const count = Number(hasWhats) + Number(hasInsta) + Number(hasFace);

  if (count >= 2) return "multi";
  if (hasWhats) return "whatsapp";
  if (hasInsta) return "instagram";
  if (hasFace) return "facebook";

  return null;
}

// Parse simple: soporta "Nombre Apellido email teléfono país"
function parseDatosCliente(text: string) {
  const raw = (text || '').trim();
  if (!raw) return null;

  const email = raw.match(EMAIL_REGEX)?.[0] || null;
  const phoneRaw = raw.match(PHONE_REGEX)?.[0] || null;
  const telefono = phoneRaw ? phoneRaw.replace(/[^\d+]/g, '') : null;

  if (!email || !telefono) return null;

  // Quita email y teléfono del texto y lo que quede lo usamos para nombre/pais
  let rest = raw.replace(email, ' ').replace(phoneRaw || '', ' ');
  rest = rest.replace(/\s+/g, ' ').trim();

  // Si vienen en orden: nombre (2 primeras palabras) + país (resto)
  const parts = rest.split(' ').filter(Boolean);
  if (parts.length < 3) return null;

  const nombre = parts.slice(0, 2).join(' ').trim();       // Nombre + Apellido
  const pais = parts.slice(2).join(' ').trim();

  if (!nombre || !pais) return null;

  return { nombre, email, telefono, pais };
}

const MAX_WHATSAPP_LINES = 16; // 14–16 es el sweet spot

const router = Router();
const MessagingResponse = twilio.twiml.MessagingResponse;

// Normalizadores
const normLang = (code?: string | null) => {
  if (!code) return null;
  const base = code.toString().split(/[-_]/)[0].toLowerCase();
  return base === 'zxx' ? null : base; // zxx = sin lenguaje
};
const normalizeLang = (code?: string | null): 'es' | 'en' =>
  (code || '').toLowerCase().startsWith('en') ? 'en' : 'es';

// BOOKING HELPERS
const BOOKING_TZ = "America/New_York";

async function getWhatsAppModeStatus(tenantId: string): Promise<{
  mode: "twilio" | "cloudapi";
  status: "enabled" | "disabled";
}> {
  const { rows } = await pool.query(
    `SELECT whatsapp_mode, whatsapp_status
       FROM tenants
      WHERE id = $1
      LIMIT 1`,
    [tenantId]
  );

  const row = rows[0] || {};
  const modeRaw = String(row.whatsapp_mode || "twilio").trim().toLowerCase();
  const statusRaw = String(row.whatsapp_status || "disabled").trim().toLowerCase();

  const mode: "twilio" | "cloudapi" = modeRaw === "cloudapi" ? "cloudapi" : "twilio";

  // backward compatible si guardabas "connected/active"
  const status: "enabled" | "disabled" =
    (statusRaw === "enabled" || statusRaw === "active" || statusRaw === "connected")
      ? "enabled"
      : "disabled";

  return { mode, status };
}

async function ensureClienteBase(
  tenantId: string,
  canal: string,
  contacto: string
): Promise<boolean> {
  try {
    const r = await pool.query(
      `
      INSERT INTO clientes (tenant_id, canal, contacto, created_at, updated_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      ON CONFLICT (tenant_id, canal, contacto)
      DO UPDATE SET updated_at = NOW()
      RETURNING (xmax = 0) AS inserted
      `,
      [tenantId, canal, contacto]
    );

    return r.rows?.[0]?.inserted === true; // ✅ true = primer mensaje de ese contacto
  } catch (e: any) {
    console.warn("⚠️ ensureClienteBase FAILED", e?.message);
    return false;
  }
}

async function getIdiomaClienteDB(
  tenantId: string,
  canal: string,
  contacto: string,
  fallback: 'es'|'en'
): Promise<'es'|'en'> {
  try {
    const { rows } = await pool.query(
      `SELECT idioma
        FROM clientes
        WHERE tenant_id = $1 AND canal = $2 AND contacto = $3
        LIMIT 1`,
      [tenantId, canal, contacto]
    );
    if (rows[0]?.idioma) return normalizeLang(rows[0].idioma);
  } catch {}
  return fallback;
}

async function upsertIdiomaClienteDB(
  tenantId: string,
  canal: string,
  contacto: string,
  idioma: 'es'|'en'
) {
  try {
    await pool.query(
      `INSERT INTO clientes (tenant_id, canal, contacto, idioma)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (tenant_id, canal, contacto)
      DO UPDATE SET
        idioma = EXCLUDED.idioma,
        updated_at = now()`,
      [tenantId, canal, contacto, idioma]
    );
  } catch (e) {
    console.warn('No se pudo guardar idioma del cliente:', e);
  }
}

async function getSelectedChannelDB(
  tenantId: string,
  canal: string,
  contacto: string
): Promise<"whatsapp" | "instagram" | "facebook" | "multi" | null> {
  try {
    const { rows } = await pool.query(
      `SELECT selected_channel
       FROM clientes
       WHERE tenant_id=$1 AND canal=$2 AND contacto=$3
       LIMIT 1`,
      [tenantId, canal, contacto]
    );
    const v = String(rows[0]?.selected_channel || "").trim().toLowerCase();
    if (v === "whatsapp" || v === "instagram" || v === "facebook" || v === "multi") return v as any;
  } catch {}
  return null;
}

async function upsertSelectedChannelDB(
  tenantId: string,
  canal: string,
  contacto: string,
  selected: "whatsapp" | "instagram" | "facebook" | "multi"
) {
  try {
    await pool.query(
      `INSERT INTO clientes (tenant_id, canal, contacto, selected_channel, selected_channel_updated_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (tenant_id, canal, contacto)
       DO UPDATE SET
         selected_channel = EXCLUDED.selected_channel,
         selected_channel_updated_at = NOW(),
         updated_at = NOW()`,
      [tenantId, canal, contacto, selected]
    );
  } catch (e) {
    console.warn("⚠️ No se pudo guardar selected_channel:", e);
  }
}

async function applyAwaitingEffects(opts: {
  tenantId: string;
  canal: Canal;
  contacto: string;
  effects?: any;
}) {
  const { tenantId, canal, contacto, effects } = opts;
  const aw = effects?.awaiting;
  if (!aw) return;

  // 1) clear awaiting si aplica
  if (aw.clear) {
    await clearAwaitingState(tenantId, canal, contacto);
  }

  // 2) persistir el valor capturado (SIN HARDCODE de negocio; solo mapeo de campos)
  const field = String(aw.field || "");
  const value = aw.value;

  // Mapea tus campos de awaiting a los “upserts” correctos.
  // Si mañana agregas otro campo, lo añades aquí y listo.
  if (field === "select_channel" || field === "canal" || field === "canal_a_automatizar") {
    if (value === "whatsapp" || value === "instagram" || value === "facebook" || value === "multi") {
      await upsertSelectedChannelDB(tenantId, canal, contacto, value);
    }
    return;
  }

  if (field === "select_language") {
    if (value === "es" || value === "en") {
      await upsertIdiomaClienteDB(tenantId, canal, contacto, value);
    }
    return;
  }

  // Para collect_* por ahora no hacemos nada aquí (porque depende de tu schema),
  // pero dejamos el hook listo para cuando decidas dónde guardarlo.
  // Ejemplo: collect_contact_email -> clientes.email, etc.
}

// Evita enviar duplicado si Twilio reintenta el webhook
async function safeSend(
  tenantId: string,
  canal: string,
  messageId: string | null,
  toNumber: string,
  text: string
): Promise<boolean> {
  try {
    const dedupeId = outboundId(messageId);

    // Sin messageId: no podemos deduplicar confiable → enviamos 1 vez y contamos si ok.
    if (!dedupeId) {
      const ok = await enviarWhatsApp(toNumber, text, tenantId);
      if (ok) await incrementarUsoPorCanal(tenantId, canal);
      return !!ok;
    }

    // ✅ RESERVA ATÓMICA: si ya existe, no envía
    const ins = await pool.query(
      `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (tenant_id, canal, message_id) DO NOTHING
       RETURNING 1`,
      [tenantId, canal, dedupeId]
    );

    if (ins.rowCount === 0) {
      console.log('⏩ safesend: ya reservado/enviado este outbound message_id. No envío ni cuento.');
      return true;
    }

    const ok = await enviarWhatsApp(toNumber, text, tenantId);
    if (ok) await incrementarUsoPorCanal(tenantId, canal);

    // Si falló el envío, libera la reserva para permitir retry real
    if (!ok) {
      await pool.query(
        `DELETE FROM interactions WHERE tenant_id=$1 AND canal=$2 AND message_id=$3`,
        [tenantId, canal, dedupeId]
      );
    }

    return !!ok;
  } catch (e) {
    console.error('❌ safesend error:', e);
    return false;
  }
}

// ⬇️ AQUÍ VA EL HELPER NUEVO
async function saveAssistantMessageAndEmit(opts: {
  tenantId: string;
  canal: Canal;   // ✅ en vez de string
  fromNumber: string;
  messageId: string | null;
  content: string;
  intent?: string | null;
  interest_level?: number | null;
}) {
  const { tenantId, canal, fromNumber, messageId, content, intent, interest_level } = opts;

  try {
    const finalMessageId = messageId ? `${messageId}-bot` : null;

    const { rows } = await pool.query(
      `INSERT INTO messages (
        tenant_id, role, content, timestamp, canal, from_number, message_id, intent, interest_level
      )
      VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5, $6, $7)
      ON CONFLICT (tenant_id, message_id) DO NOTHING
      RETURNING id, timestamp, role, content, canal, from_number`,
      [
        tenantId,
        content,
        canal,
        fromNumber || "anónimo",
        finalMessageId,
        opts.intent || null,
        (typeof opts.interest_level === "number" ? opts.interest_level : null),
      ]
    );

    const inserted = rows[0];
    if (!inserted) {
      // ya existía → no emitimos nada
      return;
    }

    const io = getIO();
    if (!io) {
      console.warn('⚠️ [SOCKET] getIO() devolvió null al guardar assistant.');
      return;
    }

    const payload = {
      id: inserted.id,
      created_at: inserted.timestamp,
      timestamp: inserted.timestamp,
      role: inserted.role,
      content: inserted.content,
      canal: inserted.canal,
      from_number: inserted.from_number,
    };

    console.log('📡 [SOCKET] Emitting message:new (assistant)', payload);
    io.emit('message:new', payload);
  } catch (e) {
    console.warn('⚠️ No se pudo registrar mensaje assistant + socket:', e);
  }
}

function extractBookingLinkFromPrompt(promptBase: string): string | null {
  if (!promptBase) return null;

  // Preferido: marcador LINK_RESERVA:
  const tagged = promptBase.match(/LINK_RESERVA:\s*(https?:\/\/\S+)/i);
  if (tagged?.[1]) return tagged[1].replace(/[),.]+$/g, "");

  // fallback: nada (no adivines)
  return null;
}

async function rememberAfterReply(opts: {
  tenantId: string;
  senderId: string;          // contactoNorm
  idiomaDestino: 'es'|'en';
  userText: string;
  assistantText: string;
  lastIntent?: string | null;
}) {
  const { tenantId, senderId, idiomaDestino, userText, assistantText, lastIntent } = opts;

  try {
    await rememberTurn({
      tenantId,
      canal: "whatsapp",
      senderId,
      userText,
      assistantText,
    });

    await rememberFacts({
      tenantId,
      canal: "whatsapp",
      senderId,
      preferredLang: idiomaDestino,
      lastIntent: lastIntent || null,
    });

    await refreshFactsSummary({
      tenantId,
      canal: "whatsapp",
      senderId,
      idioma: idiomaDestino,
    });
  } catch (e) {
    console.warn("⚠️ rememberAfterReply failed:", e);
  }
}

async function saveUserMessageAndEmit(opts: {
  tenantId: string;
  canal: Canal;
  fromNumber: string;
  messageId: string | null;
  content: string;
  intent?: string | null;
  interest_level?: number | null;
  emotion?: string | null; // ✅ NUEVO
}) {
  const { tenantId, canal, fromNumber, messageId, content, emotion } = opts;

  if (!messageId) return;

  try {
    const { rows } = await pool.query(
      `INSERT INTO messages (
        tenant_id, role, content, timestamp, canal, from_number, message_id, intent, interest_level, emotion
      )
      VALUES ($1, 'user', $2, NOW(), $3, $4, $5, $6, $7, $8)
      ON CONFLICT (tenant_id, message_id) DO NOTHING
      RETURNING id, timestamp, role, content, canal, from_number, intent, interest_level, emotion`,
      [
        tenantId,
        content,
        canal,
        fromNumber || "anónimo",
        messageId,
        opts.intent || null,
        (typeof opts.interest_level === "number" ? opts.interest_level : null),
        (typeof emotion === "string" && emotion.trim() ? emotion.trim() : null), // ✅ $8
      ]
    );

    const inserted = rows[0];
    if (!inserted) return;

    const io = getIO();
    if (!io) return;

    io.emit("message:new", {
      id: inserted.id,
      created_at: inserted.timestamp,
      timestamp: inserted.timestamp,
      role: inserted.role,
      content: inserted.content,
      canal: inserted.canal,
      from_number: inserted.from_number,
      intent: inserted.intent,
      interest_level: inserted.interest_level,
      emotion: inserted.emotion, // ✅
    });
  } catch (e) {
    console.warn("⚠️ No se pudo registrar mensaje user + socket:", e);
  }
}

// ✅ HISTORIAL CORTO PARA OPENAI (últimos turnos)
// PÉGALO debajo de saveUserMessageAndEmit y antes de router.post(...)
async function getRecentHistoryForModel(opts: {
  tenantId: string;
  canal: Canal;
  fromNumber: string;
  excludeMessageId?: string | null;
  limit?: number;
}): Promise<ChatCompletionMessageParam[]> {
  const { tenantId, canal, fromNumber, excludeMessageId = null, limit = 12 } = opts;

  try {
    const whereExclude = excludeMessageId ? `AND message_id <> $4` : '';
    const params = excludeMessageId
      ? [tenantId, canal, fromNumber, excludeMessageId, limit]
      : [tenantId, canal, fromNumber, limit];

    const sql = excludeMessageId
      ? `
        SELECT role, content
        FROM messages
        WHERE tenant_id = $1
          AND canal = $2
          AND from_number = $3
          ${whereExclude}
          AND role IN ('user','assistant')
        ORDER BY timestamp DESC
        LIMIT $5
      `
      : `
        SELECT role, content
        FROM messages
        WHERE tenant_id = $1
          AND canal = $2
          AND from_number = $3
          AND role IN ('user','assistant')
        ORDER BY timestamp DESC
        LIMIT $4
      `;

    const { rows } = await pool.query(sql, params);

    return rows.reverse().map((m: any) => {
      const content = String(m.content || "");
      return m.role === "assistant"
        ? ({ role: "assistant" as const, content })
        : ({ role: "user" as const, content });
    });
  } catch (e) {
    console.warn("⚠️ getRecentHistoryForModel failed:", e);
    return [];
  }
}

// ===============================
// 🧠 STATE MACHINE (conversational brain)
// ===============================
const sm = createStateMachine([
  humanOverrideGate, 
  paymentHumanGate,
  yesNoStateGate,
  awaitingGate,
]);

router.post("/", async (req: Request, res: Response) => {
  try {
    // Responde a Twilio de inmediato
    res.type("text/xml").send(new MessagingResponse().toString());

    // Procesa el mensaje aparte (no bloquea la respuesta a Twilio)
    setTimeout(() => {
      procesarMensajeWhatsApp(req.body).catch((err) => {
        console.error("❌ procesarMensajeWhatsApp failed (async):", err);
      });
    }, 0);
  } catch (error) {
    console.error("❌ Error en webhook:", error);
    res.status(500).send("Error interno");
  }
});

export default router;

export async function procesarMensajeWhatsApp(
  body: any,
  context?: WhatsAppContext
): Promise<void> {
console.log("🧨🧨🧨 PROD HIT WHATSAPP ROUTE", { ts: new Date().toISOString() });

  const decisionFlags = {
    channelSelected: false,
  };

  let alreadySent = false;

  // ✅ OPTION 1 (Single Exit): una sola salida para enviar/guardar/memoria
  let handled = false;
  let reply: string | null = null;
  let replySource: string | null = null;
  let lastIntent: string | null = null;
  let INTENCION_FINAL_CANONICA: string | null = null;

  // 🎯 Intent detection (evento)
  let detectedIntent: string | null = null;
  let detectedInterest: number | null = null;

  let replied = false;

  // ✅ Decision metadata (backend NO habla, solo decide)
  let nextAction: {
    type: string;
    decision?: "yes" | "no";
    kind?: string | null;
    intent?: string | null;
  } | null = null;

  const turn = await buildTurnContext({ pool, body, context });

  // canal puede venir en el contexto (meta/preview) o por defecto 'whatsapp'
  const canal: Canal = (context?.canal as Canal) || "whatsapp";

  const userInput = turn.userInputRaw;
  const messageId = turn.messageId;

  const tenant = turn.tenant;

  if (!tenant) {
    console.log("⛔ No se encontró tenant para este inbound (buildTurnContext).");
    return;
  }

  // 👉 idioma base del tenant (fallback)
  const tenantBase: "es" | "en" = normalizeLang(tenant?.idioma || "es");

  // ✅ idiomaDestino debe existir ANTES de armar 'event'
  let idiomaDestino: "es" | "en" = tenantBase;

  const origen = turn.origen;

  const numero = turn.numero;
  const numeroSinMas = turn.numeroSinMas;

  const fromNumber = turn.fromNumber;
  const contactoNorm = turn.contactoNorm;

  if (messageId) {
    const r = await pool.query(
      `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (tenant_id, canal, message_id) DO NOTHING
      RETURNING 1`,
      [tenant.id, canal, messageId]
    );
    if (r.rowCount === 0) {
      console.log("⏩ inbound dedupe: ya procesado messageId", messageId);
      return;
    }
  }

  const isNewLead = await ensureClienteBase(tenant.id, canal, contactoNorm);

  // ===============================
  // 📡 META CAPI — LEAD (OPCIÓN PRO): solo primer mensaje del contacto
  // ===============================
  try {
    if (isNewLead) {
      const raw = String(fromNumber || contactoNorm || "").trim();
      const phoneE164 = raw
        .replace(/^whatsapp:/i, "")
        .replace(/[^\d+]/g, "")
        .trim();

      // event_id: único por contacto (y estable)
      const phoneHash = sha256(phoneE164 || contactoNorm);
      const eventId = `lead:${tenant.id}:${phoneHash}`;

      await sendCapiEvent({
        tenantId: tenant.id,
        eventName: "Lead",
        eventId,
        userData: {
          external_id: sha256(`${tenant.id}:${contactoNorm}`),
          ...(phoneE164 ? { ph: sha256(phoneE164) } : {}),
        },
        customData: {
          channel: "whatsapp",
          source: "first_inbound_message",
          inbound_message_id: messageId || undefined,
          preview: (userInput || "").slice(0, 80),
        },
      });

      console.log("✅ CAPI Lead enviado (primer mensaje):", { tenantId: tenant.id, contactoNorm });
    } else {
      console.log("⏭️ CAPI Lead omitido (ya existía cliente):", { tenantId: tenant.id, contactoNorm });
    }
  } catch (e: any) {
    console.warn("⚠️ Error enviando CAPI Lead PRO:", e?.message);
  }

  const event = {
    pool,
    tenant,
    tenantId: tenant.id,
    canal: canal as Canal,
    contacto: contactoNorm,
    userInput,
    idiomaDestino,
    messageId,
    origen,
  };

  console.log("🔎 numero normalizado =", { numero, numeroSinMas });

  // ✅ FOLLOW-UP RESET: si el cliente volvió a escribir, cancela cualquier follow-up pendiente
  try {
    const deleted = await cancelPendingFollowUps({
      tenantId: tenant.id,
      canal: canal as any,         // 'whatsapp'
      contacto: contactoNorm,
    });

    if (deleted > 0) {
      console.log("🧹 follow-ups pendientes cancelados por nuevo inbound:", {
        tenantId: tenant.id,
        canal,
        contacto: contactoNorm,
        deleted,
        messageId,
      });
    }
  } catch (e: any) {
    console.warn("⚠️ cancelPendingFollowUps failed:", e?.message);
  }

  const setConversationStateCompat = async (
    tenantId: string,
    canal: any,          // o Canal si lo tienes importado
    senderKey: string,
    state: { activeFlow: string | null; activeStep: string | null; context?: any }
  ) => {
    await setConversationStateDB({
      tenantId,
      canal,
      senderId: senderKey,
      activeFlow: state.activeFlow ?? null,
      activeStep: state.activeStep ?? null,
      contextPatch: state.context ?? {},
    });
  };

  // ===============================
  // 🧠 conversation_state – inicio del turno (Flow/Step/Context)
  // ===============================
  const st = await getOrInitConversationState({
    tenantId: tenant.id,
    canal,
    senderId: contactoNorm,
    defaultFlow: "generic_sales",
    defaultStep: "start",
  });

  // Estado “autoritativo” del hilo
  let activeFlow = st.active_flow || "generic_sales";
  let activeStep = st.active_step || "start";
  let convoCtx = (st.context && typeof st.context === "object") ? st.context : {};

  // ===============================
  // 🌍 THREAD LANG (reusable) — después de convo_state
  // ===============================
  const convoForLang = {
    activeFlow,
    activeStep,
    context: convoCtx,
  };

  const langRes = await resolveThreadLang({
    tenantId: tenant.id,
    canal: "whatsapp",
    contacto: contactoNorm,
    tenantDefaultLang: tenantBase, // ya lo tienes calculado arriba
    userText: userInput,
    convo: convoForLang,
    getCustomerLang: async ({ tenantId, canal, contacto }) =>
      getIdiomaClienteDB(tenantId, canal, contacto, tenantBase),
    upsertCustomerLang: async ({ tenantId, canal, contacto, lang }) =>
      upsertIdiomaClienteDB(tenantId, canal, contacto, lang),
    allowExplicitSwitch: true,
  });

  // ✅ idioma final del turno (sticky + lock en loops)
  idiomaDestino = langRes.lang;

  // ✅ persistimos patch en convoCtx para lock (thread_lang / booking.lang si aplica)
  if (langRes.ctxPatch) {
    convoCtx = { ...(convoCtx || {}), ...(langRes.ctxPatch || {}) };
  }

  const promptBase = getPromptPorCanal('whatsapp', tenant, idiomaDestino);
  let promptBaseMem = promptBase;

  // ===============================
  // 🔁 Helpers de decisión (BACKEND SOLO DECIDE)
  // ===============================
  function transition(params: {
    flow?: string;
    step?: string;
    patchCtx?: any;
  }) {
    if (params.flow !== undefined) activeFlow = params.flow;
    if (params.step !== undefined) activeStep = params.step;
    if (params.patchCtx && typeof params.patchCtx === "object") {
      convoCtx = { ...(convoCtx || {}), ...params.patchCtx };
    }
  }

  // ✅ google_calendar_enabled flag (source of truth)
  let bookingEnabled = false;
  try {
    const { rows } = await pool.query(
      `SELECT google_calendar_enabled
      FROM channel_settings
      WHERE tenant_id = $1
      LIMIT 1`,
      [tenant.id]
    );
    bookingEnabled = rows[0]?.google_calendar_enabled === true;
  } catch (e: any) {
    console.warn("⚠️ No se pudo leer google_calendar_enabled:", e?.message);
  }

  function setReply(text: string, source: string, intent?: string | null) {
    replied = true;
    handled = true;
    reply = text;
    replySource = source;
    if (intent !== undefined) lastIntent = intent;
  }

  async function finalizeReply() {
    await finalizeReplyLib(
      {
        handled,
        reply,
        replySource,
        lastIntent,

        tenantId: tenant.id,
        canal,
        messageId,
        fromNumber,
        contactoNorm,
        userInput,

        idiomaDestino,

        activeFlow,
        activeStep,
        convoCtx,

        intentFallback: INTENCION_FINAL_CANONICA || null,

        onAfterOk: (nextCtx) => {
          // ✅ mantener tus variables en sync
          convoCtx = nextCtx;
        },
      },
      {
        safeSend,
        setConversationState: setConversationStateCompat,
        saveAssistantMessageAndEmit: async (opts: any) =>
        saveAssistantMessageAndEmit({
          ...opts,
          canal,
          fromNumber: contactoNorm, // ✅ fuerza el mismo key
          intent: (lastIntent || INTENCION_FINAL_CANONICA || null),
          interest_level: (typeof detectedInterest === "number" ? detectedInterest : null),
        }),
        rememberAfterReply,
      }
    );

    try {
      if (!handled || !reply) return;

      const finalIntent = (lastIntent || INTENCION_FINAL_CANONICA || "").toString().trim().toLowerCase();
      const finalNivel =
        typeof detectedInterest === "number"
          ? Math.min(3, Math.max(1, detectedInterest))
          : 2;

      if (messageId && finalIntent && esIntencionDeVenta(finalIntent) && finalNivel >= 2) {
        await recordSalesIntent({
          tenantId: tenant.id,
          contacto: contactoNorm,
          canal,
          mensaje: userInput,
          intencion: finalIntent,
          nivelInteres: finalNivel,
          messageId,
        });
      }

      // ===============================
      // 📡 META CAPI — QUALIFIED LEAD (OPCIÓN PRO): 1 vez por contacto evento 2
      // ===============================
      try {
        const finalIntent = (lastIntent || INTENCION_FINAL_CANONICA || "").toString().trim().toLowerCase();
        const finalNivel =
          typeof detectedInterest === "number"
            ? Math.min(3, Math.max(1, detectedInterest))
            : 2;

        if (messageId && finalIntent && esIntencionDeVenta(finalIntent) && finalNivel >= 2) {
          const raw = String(fromNumber || contactoNorm || "").trim();
          const phoneE164 = raw.replace(/^whatsapp:/i, "").replace(/[^\d+]/g, "").trim();
          const phoneHash = sha256(phoneE164 || contactoNorm);

          const eventId = `ql:${tenant.id}:${phoneHash}`; // ✅ 1 vez en la vida

          await sendCapiEvent({
            tenantId: tenant.id,
            eventName: "Contact",
            eventId,
            userData: {
              external_id: sha256(`${tenant.id}:${contactoNorm}`),
              ...(phoneE164 ? { ph: sha256(phoneE164) } : {}),
            },
            customData: {
              channel: "whatsapp",
              intent: finalIntent,
              interest_level: finalNivel,
              inbound_message_id: messageId,
            },
          });

          console.log("✅ CAPI Contact enviado:", { tenantId: tenant.id, contactoNorm, finalIntent, finalNivel });
        }
      } catch (e: any) {
        console.warn("⚠️ Error enviando CAPI Contact:", e?.message);
      }

      const bookingStep = (convoCtx as any)?.booking?.step;
      const inBooking = bookingStep && bookingStep !== "idle";

      // opcional: si confirmaste booking este turno
      const bookingJustCompleted = !!(convoCtx as any)?.booking_completed;

      // ===============================
      // 📡 META CAPI — EVENTO #3 (ULTRA-UNIVERSAL): Lead (solo intención FUERTE)
      // Dedupe: 1 vez por contacto cada 7 días (bucket)
      // ===============================
      try {
        const finalIntent = (lastIntent || INTENCION_FINAL_CANONICA || "").toString().trim().toLowerCase();
        const finalNivel =
          typeof detectedInterest === "number"
            ? Math.min(3, Math.max(1, detectedInterest))
            : 1;

        // SOLO intención fuerte
        if (messageId && finalIntent && esIntencionDeVenta(finalIntent) && finalNivel >= 3) {
          const raw = String(fromNumber || contactoNorm || "").trim();
          const phoneE164 = raw.replace(/^whatsapp:/i, "").replace(/[^\d+]/g, "").trim();
          const contactHash = sha256(phoneE164 || contactoNorm);

          // 1 vez cada 7 días por contacto
          const eventId = `leadstrong:${tenant.id}:${contactHash}:${bucket7DaysUTC()}`;
          const ok = await reserveCapiEvent(tenant.id, eventId);

          if (ok) {
            await sendCapiEvent({
              tenantId: tenant.id,
              eventName: "Lead", // ✅ "cliente potencial" en inglés (standard event)
              eventId,
              userData: {
                external_id: sha256(`${tenant.id}:${contactoNorm}`),
                ...(phoneE164 ? { ph: sha256(phoneE164) } : {}),
              },
              customData: {
                channel: "whatsapp",
                source: "sales_intent_strong",
                intent: finalIntent,
                interest_level: finalNivel,
                inbound_message_id: messageId || undefined,
              },
            });

            console.log("✅ CAPI Lead (#3 fuerte) enviado:", { tenantId: tenant.id, contactoNorm, finalIntent, finalNivel, eventId });
          } else {
            console.log("⏭️ CAPI Lead (#3 fuerte) deduped:", { tenantId: tenant.id, contactoNorm, eventId });
          }
        }
      } catch (e: any) {
        console.warn("⚠️ Error enviando CAPI evento #3 Lead fuerte:", e?.message);
      }

      const skipFollowUp =
        inBooking ||
        bookingJustCompleted ||
        finalIntent === "agendar_cita";

      try {
        await scheduleFollowUpIfEligible({
          tenant,
          canal,
          contactoNorm,
          idiomaDestino,
          intFinal: finalIntent || null,
          nivel: finalNivel,
          userText: userInput,
          skip: skipFollowUp, // ✅ AQUÍ
        });
      } catch (e: any) {
        console.warn("⚠️ scheduleFollowUpIfEligible failed:", e?.message);
      }
    } catch (e: any) {
      console.warn("⚠️ recordSalesIntent(final) failed:", e?.message);
    }
  }

  async function replyAndExit(text: string, source: string, intent?: string | null) {
    setReply(text, source, intent);
    await finalizeReply();
    return;
  }

  // ===============================
  // 📅 BOOKING GATE (Google Calendar) - ANTES del SM/LLM
  // ===============================
  const bookingLink = extractBookingLinkFromPrompt(promptBase);

  // ✅ Si el toggle está OFF, nunca ejecutes bookingFlowMvp (y limpia estados viejos)
  if (!bookingEnabled) {
    if ((convoCtx as any)?.booking) {
      transition({ patchCtx: { booking: null } }); // limpia en memoria del turno
      await setConversationStateCompat(tenant.id, canal, contactoNorm, {
        activeFlow,
        activeStep,
        context: { booking: null },
      });
    }
  } else {
    const bookingStep = (convoCtx as any)?.booking?.step;
    const inBooking = bookingStep && bookingStep !== "idle";

    const bk = await bookingFlowMvp({
      tenantId: tenant.id,
      canal: "whatsapp",
      contacto: contactoNorm,
      idioma: idiomaDestino,
      userText: userInput,
      ctx: convoCtx,
      bookingLink,
      messageId,
    });

    if (bk?.ctxPatch) transition({ patchCtx: bk.ctxPatch });

    // ✅ clave: si estabas en booking y el flow decide handled=false, igual NO dejes el ctx sucio
    // (ya lo limpiaste vía ctxPatch en wantsToChangeTopic, perfecto)
    if (bk?.handled) {
      // ✅ asegura persistencia del paso antes de salir
      await setConversationStateCompat(tenant.id, canal, contactoNorm, {
        activeFlow,
        activeStep,
        context: convoCtx, // ya incluye bk.ctxPatch por transition()
      });

      return await replyAndExit(
        bk.reply || (idiomaDestino === "en" ? "Ok." : "Perfecto."),
        "booking_flow",
        "agendar_cita"
      );
    }
  }

  const bookingStep0 = (convoCtx as any)?.booking?.step;
  const inBooking0 = bookingStep0 && bookingStep0 !== "idle";

  const awaiting = (convoCtx as any)?.awaiting || activeStep || null;

  // ✅ SERVICE LINK PICK (STICKY): si hay opciones pendientes, NO avanzamos el flujo
  // hasta que el usuario elija (número o texto que matchee una opción).
  {
    const pickState = (convoCtx as any)?.service_link_pick;
    const options = Array.isArray(pickState?.options) ? pickState.options : [];

    if (options.length) {
      const createdAtMs =
        typeof pickState?.created_at === "string" ? Date.parse(pickState.created_at) : NaN;

      const fresh =
        Number.isFinite(createdAtMs) ? (Date.now() - createdAtMs) < 10 * 60 * 1000 : false;

      // Expiró: limpiar y pedir que lo solicite de nuevo
      if (!fresh) {
        transition({ patchCtx: { service_link_pick: null } });
        await setConversationStateCompat(tenant.id, canal, contactoNorm, {
          activeFlow,
          activeStep,
          context: convoCtx,
        });

        const msg =
          idiomaDestino === "en"
            ? "That selection expired. Ask me again which service you want."
            : "Esa selección expiró. Vuelve a pedirme el link del servicio.";
        return await replyAndExit(msg, "service_link_pick:expired", "service_link");
      }

      // 1) Intento por número 1-5
      const n = parsePickNumber(userInput);
      if (n !== null) {
        const idx = n - 1;

        if (idx < 0 || idx >= options.length) {
          const lines = options.map((o: any, i: number) => `${i + 1}) ${o.label}`).join("\n");
          const msg =
            idiomaDestino === "en"
              ? `Please reply with a valid number:\n${lines}`
              : `Responde con un número válido:\n${lines}`;
          return await replyAndExit(msg, "service_link_pick:out_of_range", "service_link");
        }

        const chosen = options[idx];
        const url = String(chosen?.url || "").trim();

        // limpiar pick y persistir
        transition({ patchCtx: { service_link_pick: null } });
        await setConversationStateCompat(tenant.id, canal, contactoNorm, {
          activeFlow,
          activeStep,
          context: convoCtx,
        });

        if (!url) {
          const msg =
            idiomaDestino === "en"
              ? "That option doesn't have a link saved yet."
              : "Esa opción no tiene link guardado todavía.";
          return await replyAndExit(msg, "service_link_pick:no_url", "service_link");
        }

        return await replyAndExit(url, "service_link_pick:number", "service_link");
      }

      // 2) Intento por texto (ej: "large", "41+ lbs", "small")
      //    Mapeo simple: si el userText está contenido en el label o viceversa.
      const t = String(userInput || "").trim().toLowerCase();
      if (t.length >= 2) {
        const matchIdx = options.findIndex((o: any) => {
          const lbl = String(o?.label || "").toLowerCase();
          return lbl.includes(t) || t.includes(lbl);
        });

        if (matchIdx >= 0) {
          const chosen = options[matchIdx];
          const url = String(chosen?.url || "").trim();

          transition({ patchCtx: { service_link_pick: null } });
          await setConversationStateCompat(tenant.id, canal, contactoNorm, {
            activeFlow,
            activeStep,
            context: convoCtx,
          });

          if (!url) {
            const msg =
              idiomaDestino === "en"
                ? "That option doesn't have a link saved yet."
                : "Esa opción no tiene link guardado todavía.";
            return await replyAndExit(msg, "service_link_pick:text_no_url", "service_link");
          }

          return await replyAndExit(url, "service_link_pick:text", "service_link");
        }
      }

      // 3) Si hay pick pendiente y NO eligió bien -> re-preguntar y NO seguir el flujo
      const lines = options.map((o: any, i: number) => `${i + 1}) ${o.label}`).join("\n");
      const msg =
        idiomaDestino === "en"
          ? `Which option do you want? Reply with the number:\n${lines}`
          : `¿Cuál opción quieres? Responde con el número:\n${lines}`;

      return await replyAndExit(msg, "service_link_pick:reprompt", "service_link");
    }
  }


  // ===============================
  // 💲 PRICE LIST FAST-PATH (pregunta genérica "precios") — SIN LLM
  // PÉGALO antes de SERVICE INFO FAST-PATH
  // ===============================
  function wantsGeneralPrices(text: string) {
    const t = String(text || "").toLowerCase().trim();

    const asksPrice =
      /\b(precio|precios|cu[aá]nto\s+cuesta|cu[aá]nto\s+val(e|en)|tarifa|cost(o|os))\b/.test(t);

    // solo bloquea si menciona algo MUY específico (plan/bronze/paquete X/etc.)
    const mentionsSpecific =
      /\b(bronze|plan\s+bronze|paquete\s+\d+|package\s+\d+|cycling|cicl(ing)?|funcional|functional|single\s+class)\b/.test(t);

    return asksPrice && !mentionsSpecific;
  }

  if (wantsGeneralPrices(userInput)) {
    const { rows } = await pool.query(
      `
      (
        SELECT
          s.name AS label,
          NULL::text AS variant_name,
          s.price_base AS price,
          'USD'::text AS currency,
          s.service_url AS url,
          1 AS sort_group,
          s.updated_at AS updated_at
        FROM services s
        WHERE s.tenant_id = $1
          AND s.active = TRUE
          AND s.price_base IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM service_variants v2
            WHERE v2.service_id = s.id
              AND v2.active = TRUE
              AND v2.price IS NOT NULL
          )
      )
      UNION ALL
      (
        SELECT
          s.name AS label,
          v.variant_name AS variant_name,
          v.price AS price,
          COALESCE(v.currency, 'USD') AS currency,
          COALESCE(v.variant_url, s.service_url) AS url,
          2 AS sort_group,
          v.updated_at AS updated_at
        FROM services s
        JOIN service_variants v ON v.service_id = s.id
        WHERE s.tenant_id = $1
          AND s.active = TRUE
          AND v.active = TRUE
          AND v.price IS NOT NULL
      )
      ORDER BY sort_group ASC, updated_at DESC
      LIMIT 12
      `,
      [tenant.id]
    );

    if (!rows.length) {
      const msg =
        idiomaDestino === "en"
          ? "I don’t have prices saved yet."
          : "Todavía no tengo precios guardados.";
      return await replyAndExit(msg, "price_list:empty", "precios");
    }

    const lines = rows.map((r: any) => {
      const p = Number(r.price);
      const cur = String(r.currency || "USD");
      const name = r.variant_name ? `${r.label} - ${r.variant_name}` : String(r.label);
      return `• ${name}: $${p.toFixed(2)} ${cur}`;
    });

    const msg =
      idiomaDestino === "en"
        ? `Here are the current prices:\n\n${lines.join("\n")}\n\nDo you want Cycling or Functional?`
        : `Estos son los precios actuales:\n\n${lines.join("\n")}\n\n¿Te interesa Cycling o Funcional?`;

    return await replyAndExit(msg, "price_list", "precios");
  }

  // ===============================
  // 💲 SERVICE INFO FAST-PATH (precio / duración / incluye) — SIN LLM
  // ===============================
  {
    const need = wantsServiceInfo(userInput);

    if (need) {
      const r = await resolveServiceInfo({
        tenantId: tenant.id,
        query: userInput,
        limit: 5,
      });

      if (r.ok) {
        // ✅ guarda el servicio/variante resuelto como contexto del hilo
        transition({
          patchCtx: {
            last_service_ref: {
              kind: r.kind || null,
              label: r.label || null,
              service_id: r.service_id || null,
              variant_id: r.variant_id || null,
              saved_at: new Date().toISOString(),
            }
          }
        });

        await setConversationStateCompat(tenant.id, canal, contactoNorm, {
          activeFlow,
          activeStep,
          context: convoCtx,
        });

        const msg = renderServiceInfoReply(r, need, idiomaDestino);
        return await replyAndExit(msg, "service_info", "service_info");
      }

      if (r.reason === "ambiguous" && r.options?.length) {
        const options = r.options.slice(0, 5).map((o) => ({
          label: o.label,
          kind: o.kind,
          service_id: o.service_id,
          variant_id: o.variant_id || null,
        }));

        transition({
          patchCtx: {
            service_info_pick: {
              need,
              options,
              created_at: new Date().toISOString(),
            },
          },
        });

        await setConversationStateCompat(tenant.id, canal, contactoNorm, {
          activeFlow,
          activeStep,
          context: convoCtx,
        });

        const lines = options.map((o, i) => `${i + 1}) ${o.label}`).join("\n");

        const msg =
          idiomaDestino === "en"
            ? `Which one do you mean? Reply with the number:\n${lines}`
            : `¿Cuál quieres decir? Responde con el número:\n${lines}`;

        return await replyAndExit(msg, "service_info:ambiguous", "service_info");
      }

      // ✅ Si NO hubo match pero tenemos un servicio previo en contexto, úsalo.
      const lastRef = (convoCtx as any)?.last_service_ref;

      if (lastRef?.service_id) {
        // re-resolver por ID (determinístico) usando el mismo SQL que ya usas en pick
        const { rows } = await pool.query(
          `
          SELECT
            s.id AS service_id,
            s.name AS service_name,
            s.description AS service_desc,
            s.duration_min AS service_duration,
            s.price_base AS service_price_base,
            s.service_url AS service_url,

            v.id AS variant_id,
            v.variant_name,
            v.description AS variant_desc,
            v.duration_min AS variant_duration,
            v.price AS variant_price,
            v.currency AS variant_currency,
            v.variant_url AS variant_url
          FROM services s
          LEFT JOIN service_variants v ON v.id = $2 AND v.service_id = s.id
          WHERE s.tenant_id = $1
            AND s.active = TRUE
            AND s.id = $3
          LIMIT 1
          `,
          [tenant.id, lastRef.variant_id || null, lastRef.service_id]
        );

        const row = rows[0];
        if (row) {
          const price =
            row.variant_price != null ? Number(row.variant_price)
            : (row.service_price_base != null ? Number(row.service_price_base) : null);

          const currency = row.variant_currency ? String(row.variant_currency) : "USD";
          const duration_min =
            row.variant_duration != null ? Number(row.variant_duration)
            : (row.service_duration != null ? Number(row.service_duration) : null);

          const description =
            (row.variant_desc && String(row.variant_desc).trim())
              ? String(row.variant_desc)
              : (row.service_desc ? String(row.service_desc) : null);

          const url =
            (row.variant_url && String(row.variant_url).trim())
              ? String(row.variant_url)
              : (row.service_url ? String(row.service_url) : null);

          const kind: "variant" | "service" = row.variant_id ? "variant" : "service";

          const resolved = {
            ok: true as const,
            kind,
            label: row.variant_id ? `${row.service_name} - ${row.variant_name}` : String(row.service_name),
            url,
            price,
            currency: (currency ?? null) as string | null,
            duration_min,
            description,
            service_id: String(row.service_id),
            variant_id: row.variant_id ? String(row.variant_id) : undefined,
          };

          const msg = renderServiceInfoReply(resolved, need, idiomaDestino);
          return await replyAndExit(msg, "service_info:ctx_last_ref", "service_info");
        }
      }

      // Si no hay last_service_ref, entonces sí pide nombre.
      const msg =
        idiomaDestino === "en"
          ? "Which service do you mean? Tell me the exact name."
          : "¿Cuál servicio exactamente? Dime el nombre.";

      return await replyAndExit(msg, "service_info:no_match", "service_info");
    }
  }
  
  // ===============================
  // 🔗 SERVICE LINK FAST-PATH (SOLO LINK)
  // Debe ir ANTES del fallback/LLM. Usa Single Exit.
  // ===============================
  if (wantsServiceLink(userInput)) {
    const resolved = await resolveServiceLink({
      tenantId: tenant.id,
      query: userInput,
      limit: 5,
    });

    if (resolved.ok) {
      // ✅ SOLO el link
      return await replyAndExit(resolved.url, "service_link", "service_link");
    }

    if (resolved.reason === "ambiguous" && resolved.options?.length) {
      const options = resolved.options.slice(0, 5).map((o) => ({
        label: o.label,
        url: o.url || null,
      }));

      // ✅ Guardar opciones en estado para que "1/2/3" funcione
      transition({
        patchCtx: {
          service_link_pick: {
            kind: "service_link_pick",
            options,
            created_at: new Date().toISOString(),
          }
        },
      });

      // ✅ persistir pick en conversation_state para que el próximo "2" funcione
      await setConversationStateCompat(tenant.id, canal, contactoNorm, {
        activeFlow,
        activeStep,
        context: convoCtx,
      });

      const lines = options
        .map((o, i) => `${i + 1}) ${o.label}`)
        .join("\n");

      const msg =
        idiomaDestino === "en"
          ? `Which service do you want the link for? Reply with the number:\n${lines}`
          : `¿De cuál servicio quieres el link? Responde con el número:\n${lines}`;

      return await replyAndExit(msg, "service_link:ambiguous", "service_link");
    }

    const msg =
      idiomaDestino === "en"
        ? "Which service do you need the link for? Tell me the exact name."
        : "¿De cuál servicio necesitas el link exactamente? Dime el nombre.";

    return await replyAndExit(msg, "service_link:no_match", "service_link");
  }

  // ===============================
  // 📋 SERVICE LIST FAST-PATH (lista desde DB) — SIN LLM
  // ===============================
  if (wantsServiceList(userInput)) {
    const r = await resolveServiceList({ tenantId: tenant.id, limitServices: 8, limitVariantsPerService: 3 });

    if (r.ok) {
      const msg = renderServiceListReply(r.items, idiomaDestino);
      return await replyAndExit(msg, "service_list", "service_list");
    }

    const msg =
      idiomaDestino === "en"
        ? "I don’t have services saved yet."
        : "Todavía no tengo servicios guardados.";
    return await replyAndExit(msg, "service_list:empty", "service_list");
  }

  // ✅ SERVICE INFO PICK (STICKY): si hay opciones pendientes para precio/duración/incluye
  {
    const pickState = (convoCtx as any)?.service_info_pick;
    const options = Array.isArray(pickState?.options) ? pickState.options : [];

    if (options.length) {
      const createdAtMs =
        typeof pickState?.created_at === "string" ? Date.parse(pickState.created_at) : NaN;

      const fresh =
        Number.isFinite(createdAtMs) ? (Date.now() - createdAtMs) < 10 * 60 * 1000 : false;

      if (!fresh) {
        transition({ patchCtx: { service_info_pick: null } });
        await setConversationStateCompat(tenant.id, canal, contactoNorm, {
          activeFlow,
          activeStep,
          context: convoCtx,
        });

        const msg =
          idiomaDestino === "en"
            ? "That selection expired. Ask again about the service."
            : "Esa selección expiró. Vuelve a preguntarme por el servicio.";
        return await replyAndExit(msg, "service_info_pick:expired", "service_info");
      }

      const n = parsePickNumber(userInput);
      if (n === null) {
        const lines = options.map((o: any, i: number) => `${i + 1}) ${o.label}`).join("\n");
        const msg =
          idiomaDestino === "en"
            ? `Reply with the number:\n${lines}`
            : `Responde con el número:\n${lines}`;
        return await replyAndExit(msg, "service_info_pick:reprompt", "service_info");
      }

      const idx = n - 1;
      if (idx < 0 || idx >= options.length) {
        const lines = options.map((o: any, i: number) => `${i + 1}) ${o.label}`).join("\n");
        const msg =
          idiomaDestino === "en"
            ? `Please reply with a valid number:\n${lines}`
            : `Responde con un número válido:\n${lines}`;
        return await replyAndExit(msg, "service_info_pick:out_of_range", "service_info");
      }

      const chosen = options[idx];
      const need = (pickState?.need || "any") as any;

      // Resolver por IDs (determinístico)
      let resolved: any = null;

      if (chosen.kind === "variant" && chosen.variant_id) {
        const { rows } = await pool.query(
          `
          SELECT s.id AS service_id, s.name AS service_name, s.description AS service_desc,
                s.duration_min AS service_duration, s.price_base, s.service_url,
                v.id AS variant_id, v.variant_name, v.description AS variant_desc,
                v.duration_min AS variant_duration, v.price, v.currency, v.variant_url
          FROM service_variants v
          JOIN services s ON s.id = v.service_id
          WHERE s.tenant_id = $1
            AND s.active = TRUE
            AND v.active = TRUE
            AND v.id = $2
          LIMIT 1
          `,
          [tenant.id, chosen.variant_id]
        );
        const row = rows[0];
        const price =
          row.price !== null && row.price !== undefined
            ? Number(row.price)
            : (row.price_base !== null && row.price_base !== undefined ? Number(row.price_base) : null);

        const currency =
          row.currency ? String(row.currency) : "USD";

        if (row) {
          resolved = {
            ok: true,
            kind: "variant",
            label: `${row.service_name} - ${row.variant_name}`,
            url: row.variant_url || row.service_url || null,
            price,
            currency,
            duration_min:
              row.variant_duration !== null
                ? Number(row.variant_duration)
                : (row.service_duration !== null ? Number(row.service_duration) : null),
            description:
              (row.variant_desc && String(row.variant_desc).trim())
                ? String(row.variant_desc)
                : (row.service_desc ? String(row.service_desc) : null),
            service_id: String(row.service_id),
            variant_id: String(row.variant_id),
          };
        }
      } else {
        const { rows } = await pool.query(
          `
          SELECT
            s.id AS service_id,
            s.name AS service_name,
            s.description AS service_desc,
            s.duration_min AS service_duration,
            s.price_base AS service_price_base,
            s.service_url AS service_url,

            v.id AS variant_id,
            v.variant_name,
            v.description AS variant_desc,
            v.duration_min AS variant_duration,
            v.price AS variant_price,
            v.currency AS variant_currency,
            v.variant_url AS variant_url
          FROM services s
          LEFT JOIN LATERAL (
            SELECT v.*
            FROM service_variants v
            WHERE v.service_id = s.id
              AND v.active = TRUE
              AND v.price IS NOT NULL
            ORDER BY v.sort_order NULLS LAST, v.updated_at DESC
            LIMIT 1
          ) v ON TRUE
          WHERE s.tenant_id = $1
            AND s.active = TRUE
            AND s.id = $2
          LIMIT 1
          `,
          [tenant.id, chosen.service_id]
        );

        const row = rows[0];
        if (row) {
          // ✅ Preferir precio de variante si existe; si no, usar service_price_base
          const price =
            row.variant_price !== null && row.variant_price !== undefined
              ? Number(row.variant_price)
              : (row.service_price_base !== null ? Number(row.service_price_base) : null);

          const currency =
            row.variant_currency ? String(row.variant_currency) : "USD";

          const url =
            (row.variant_url && String(row.variant_url).trim())
              ? String(row.variant_url)
              : (row.service_url ? String(row.service_url) : null);

          const duration_min =
            row.variant_duration !== null && row.variant_duration !== undefined
              ? Number(row.variant_duration)
              : (row.service_duration !== null ? Number(row.service_duration) : null);

          const description =
            (row.variant_desc && String(row.variant_desc).trim())
              ? String(row.variant_desc)
              : (row.service_desc ? String(row.service_desc) : null);

          resolved = {
            ok: true,
            kind: row.variant_id ? "variant" : "service",  // 👈 si hay variante con precio, úsala
            label: row.variant_id
              ? `${row.service_name} - ${row.variant_name}`
              : String(row.service_name),
            url,
            price,
            currency,
            duration_min,
            description,
            service_id: String(row.service_id),
            variant_id: String(row.variant_id),
          };
        }
      }

      // limpiar pick y persistir
      transition({ patchCtx: { service_info_pick: null } });
      await setConversationStateCompat(tenant.id, canal, contactoNorm, {
        activeFlow,
        activeStep,
        context: convoCtx,
      });

      if (resolved?.ok) {
        transition({
          patchCtx: {
            last_service_ref: {
              kind: resolved.kind || null,
              label: resolved.label || null,
              service_id: resolved.service_id || null,
              variant_id: resolved.variant_id || null,
              saved_at: new Date().toISOString(),
            }
          }
        });

        await setConversationStateCompat(tenant.id, canal, contactoNorm, {
          activeFlow,
          activeStep,
          context: convoCtx,
        });

        const msg = renderServiceInfoReply(resolved, need, idiomaDestino);
        return await replyAndExit(msg, "service_info_pick", "service_info");
      }

      const msg =
        idiomaDestino === "en"
          ? "I couldn't find that option anymore. Ask again about the service."
          : "No pude encontrar esa opción ya. Vuelve a preguntarme por el servicio.";
      return await replyAndExit(msg, "service_info_pick:not_found", "service_info");
    }
  }

  // ===============================
  // 🔎 DEBUG: estado de flujo (clientes)
  // ===============================
  try {
    const { rows } = await pool.query(
      `SELECT estado, human_override, info_explicada, selected_channel
      FROM clientes
      WHERE tenant_id = $1 AND canal = $2 AND contacto = $3
      LIMIT 1`,
      [tenant.id, canal, contactoNorm]
    );

    console.log("🧩 CLIENTE STATE (pre-flow) =", {
      tenantId: tenant.id,
      canal,
      contacto: contactoNorm,
      estado: rows[0]?.estado ?? null,
      human_override: rows[0]?.human_override ?? null,
      info_explicada: rows[0]?.info_explicada ?? null,
      selected_channel: rows[0]?.selected_channel ?? null,
    });
  } catch (e: any) {
    console.warn("⚠️ No se pudo leer state de clientes:", e?.message);
  }

  // ===============================
  // 🔎 Estado persistido (FIX 4)
  // ===============================
  const selectedChannel = await getSelectedChannelDB(
    tenant.id,
    canal,
    contactoNorm
  );

  if (selectedChannel) {
    decisionFlags.channelSelected = true;
  }

  // 🔍 MEMORIA – inicio del turno (antes de cualquier lógica)
  const memStart = await getMemoryValue<string>({
    tenantId: tenant.id,
    canal: "whatsapp",
    senderId: contactoNorm,
    key: "facts_summary",
  });

console.log("🧠 facts_summary (start of turn) =", memStart);

  const { mode, status } = await getWhatsAppModeStatus(tenant.id);

  const guard = await whatsappModeMembershipGuard({
    tenant,
    tenantId: tenant.id,
    canal,
    origen,
    mode,
    status,
    // requireMembershipActive: true, // (default)
  });

  if (!guard.ok) return;

  // ===============================
  // 🎯 Intent detection (evento)
  // ===============================
  try {
    const det = await detectarIntencion(userInput, tenant.id, canal);

    const intent = (det?.intencion || "").toString().trim().toLowerCase();
    const levelRaw = Number(det?.nivel_interes);
    const nivel = Number.isFinite(levelRaw) ? Math.min(3, Math.max(1, levelRaw)) : 1;

    console.log("🎯 detectarIntencion =>", { intent, nivel, canal, tenantId: tenant.id, messageId });

    if (intent) {
      detectedIntent = intent;
      detectedInterest = nivel;
      INTENCION_FINAL_CANONICA = intent;
      lastIntent = intent;

      transition({
        patchCtx: { last_intent: intent, last_interest_level: nivel },
      });
    }
  } catch (e: any) {
    console.warn("⚠️ detectarIntencion failed:", e?.message, e?.code, e?.detail);
  }

  let emotion: string | null = null;
  try {
    const emoRaw: any = await detectarEmocion(userInput, idiomaDestino);

    emotion =
      typeof emoRaw === "string"
        ? emoRaw
        : (emoRaw?.emotion || emoRaw?.emocion || emoRaw?.label || null);

    emotion = typeof emotion === "string" ? emotion.trim().toLowerCase() : null;
  } catch {}

  if (typeof emotion === "string" && emotion.trim()) {
    transition({ patchCtx: { last_emotion: emotion.trim().toLowerCase() } });
  }

  await saveUserMessageAndEmit({
    tenantId: tenant.id,
    canal,
    fromNumber: contactoNorm, // ✅ usa fromNumber real
    messageId,
    content: userInput || '',
    intent: detectedIntent,
    interest_level: detectedInterest,
    emotion,
  });

  // ===============================
  // 🎭 EMOTION TRIGGERS (acciones, no config)
  // ===============================
  try {
    const trig = await applyEmotionTriggers({
      tenantId: tenant.id,
      canal,
      contacto: contactoNorm,
      emotion,
      intent: detectedIntent,
      interestLevel: detectedInterest,

      userMessage: userInput || null,   // ✅
      messageId: messageId || null,     // ✅
    });

    // Persistimos señales para SM/LLM/Debug
    if (trig?.ctxPatch) {
      transition({ patchCtx: trig.ctxPatch });
    }

    // Si requiere handoff, respondemos y salimos (Single Exit)
    if (trig?.action === "handoff_human" && trig.replyOverride) {
      await setHumanOverride({
        tenantId: tenant.id,
        canal,
        contacto: contactoNorm,
        minutes: 5,
        reason: (emotion || trig?.ctxPatch?.handoff_reason || "emotion").toString(),
        source: "emotion",
        customerPhone: fromNumber || contactoNorm,
        userMessage: userInput,
        messageId: messageId || null,
      });

      return await replyAndExit(trig.replyOverride, "emotion_trigger", detectedIntent);
    }
  } catch (e: any) {
    console.warn("⚠️ applyEmotionTriggers failed:", e?.message);
  }

  // ===============================
  // ✅ MEMORIA (3): Retrieval → inyectar memoria del cliente en el prompt
  // ===============================

  try {
    const memRaw = await getMemoryValue<any>({
      tenantId: tenant.id,
      canal: "whatsapp",
      senderId: contactoNorm,
      key: "facts_summary",
    });

    const memText =
      typeof memRaw === "string"
        ? memRaw
        : (memRaw && typeof memRaw === "object" && typeof memRaw.text === "string")
          ? memRaw.text
          : "";

    console.log("🧠 facts_summary =", memText);

    if (memText.trim()) {
      promptBaseMem = [
        promptBase,
        "",
        "MEMORIA_DEL_CLIENTE (usa esto solo si ayuda a responder mejor; no lo inventes):",
        memText.trim(),
      ].join("\n");
    }

    if ((convoCtx as any)?.needs_clarify) {
      promptBaseMem +=
        "\n\nINSTRUCCION: El usuario está frustrado. Responde con 2 bullets y haz 1 sola pregunta para aclarar.";
    }

  } catch (e) {
    console.warn("⚠️ No se pudo cargar memoria (getMemoryValue):", e);
  }

  // ===============================
  // ✅ POST-BOOKING COURTESY GUARD
  // Evita que después de agendar, un "gracias" dispare el saludo inicial.
  // ===============================
  {
    const lastDoneAt = (convoCtx as any)?.booking_last_done_at;
    const completedAtISO = (convoCtx as any)?.booking_completed_at;

    // soporta epoch (number) o ISO
    const lastMs =
      typeof lastDoneAt === "number"
        ? lastDoneAt
        : (typeof completedAtISO === "string" ? Date.parse(completedAtISO) : null);

    if (lastMs && Number.isFinite(lastMs)) {
      const seconds = (Date.now() - lastMs) / 1000;

      // ventana: 10 minutos (ajústala)
      if (seconds >= 0 && seconds < 10 * 60) {
        const t = (userInput || "").toString().trim().toLowerCase();

        const courtesy =
          /^(gracias|muchas gracias|thank you|thanks|ok|okay|perfecto|listo|vale|dale|bien|genial|super|cool)$/i.test(t);

        // Si solo fue cortesía, no saludes, no reinicies, responde breve y humano.
        if (courtesy) {
          const replyText =
            idiomaDestino === "en"
              ? "You’re welcome."
              : "A la orden.";

          return await replyAndExit(replyText, "post_booking_courtesy", "cortesia");
        }
      }
    }
  }

  // 👋 GREETING GATE: SOLO si NO estamos en booking
  if (
    !inBooking0 &&
    saludoPuroRegex.test(userInput) &&
    !looksLikeBookingPayload(userInput) // ✅ evita “Hola soy Amy” cuando mandan nombre/email/fecha
  ) {
    const bienvenida = getBienvenidaPorCanal("whatsapp", tenant, idiomaDestino);

    transition({
      flow: activeFlow,
      step: "answer",
      patchCtx: {
        reset_reason: "greeting",
        last_user_text: userInput,
        last_bot_action: "welcome_sent",
        last_reply_source: "welcome_gate",
        last_assistant_text: bienvenida,
      },
    });

    return await replyAndExit(bienvenida, "welcome_gate", "saludo");
  }

  const smResult = await sm({
    pool,
    tenantId: tenant.id,
    canal,
    contacto: contactoNorm,
    userInput,
    messageId,
    idiomaDestino,
    promptBase, // el base SIN memoria (para payment link)
    parseDatosCliente,
    extractPaymentLinkFromPrompt,
    PAGO_CONFIRM_REGEX, // si lo quieres inyectar
  } as any);

  if (smResult.action === "silence") {
    console.log("🧱 [SM] silence:", smResult.reason);
    return;
  }

  if (smResult.action === "reply") {
    // Aplica side-effects declarados (awaiting, etc.)
    if (smResult.transition?.effects) {
      await applyAwaitingEffects({
        tenantId: event.tenantId,
        canal: event.canal,
        contacto: event.contacto,
        effects: smResult.transition.effects,
      });
    }

    const history = await getRecentHistoryForModel({
      tenantId: tenant.id,
      canal,
      fromNumber: contactoNorm, // ✅ usa fromNumber real
      excludeMessageId: messageId,
      limit: 12,
    });

    // ✅ Guardrail reusable: si huele a booking, NO pases al LLM
    const gr = await runBookingGuardrail({
      bookingEnabled,
      bookingLink,
      tenantId: tenant.id,
      canal: "whatsapp",
      contacto: contactoNorm,
      idioma: idiomaDestino,
      userText: userInput,
      ctx: convoCtx,
      messageId,
      detectedIntent: detectedIntent || INTENCION_FINAL_CANONICA || null,
      bookingFlow: bookingFlowMvp, // DI
    });

    if (gr.result?.ctxPatch) transition({ patchCtx: gr.result.ctxPatch });

    if (gr.hit && gr.result?.handled) {
      await setConversationStateCompat(tenant.id, canal, contactoNorm, {
        activeFlow,
        activeStep,
        context: convoCtx,
      });

      return await replyAndExit(
        gr.result.reply || (idiomaDestino === "en" ? "Ok." : "Perfecto."),
        "booking_guardrail:sm_reply",
        "agendar_cita"
      );
    }

    const composed = await answerWithPromptBase({
      tenantId: event.tenantId,
      promptBase: promptBaseMem,
      userInput: [
        "SYSTEM_EVENT_FACTS (use to respond; do not mention systems; keep it short):",
        JSON.stringify(smResult.facts || {}),
        "",
        "USER_MESSAGE:",
        event.userInput,
      ].join("\n"),
      history, // ✅ aquí
      idiomaDestino,
      canal: "whatsapp",
      maxLines: MAX_WHATSAPP_LINES,
      fallbackText: getBienvenidaPorCanal("whatsapp", tenant, idiomaDestino),
    });

    return await replyAndExit(
      composed.text,
      smResult.replySource || "state_machine",
      smResult.intent || null
    );
  }

  // 🛡️ Anti-phishing (Single Exit): NO enviar aquí; capturar y salir por finalize
  {
    let phishingReply: string | null = null;

    const handledPhishing = await antiPhishingGuard({
      pool,
      tenantId: tenant.id,
      channel: "whatsapp",
      senderId: contactoNorm,
      messageId,
      userInput,
      idiomaDestino,
      send: async (text: string) => {
        phishingReply = text; // ✅ solo capturo
      },
    });

    if (handledPhishing) {
      transition({
        flow: "generic_sales",
        step: "close",
        patchCtx: {
          guard: "phishing",
          last_bot_action: "blocked_phishing",
        },
      });

      return await replyAndExit(
        phishingReply || (idiomaDestino === "en" ? "Got it." : "Perfecto."),
        "phishing",
        "seguridad"
      );
    }
  }

  // ===============================
  // ✅ CANAL ELEGIDO (DECISION-ONLY)
  // ===============================
  if (!decisionFlags.channelSelected) {
    const picked = pickSelectedChannelFromText(userInput);

    if (picked) {
      await upsertSelectedChannelDB(tenant.id, canal, contactoNorm, picked);
      decisionFlags.channelSelected = true;
    }
  }

  const history = await getRecentHistoryForModel({
    tenantId: tenant.id,
    canal,
    fromNumber: contactoNorm, // ✅ usa fromNumber real
    excludeMessageId: messageId,
    limit: 12,
  });

  // ===============================
  // ✅ FALLBACK ÚNICO (solo si SM no respondió)
  // ===============================
  if (!replied) {
      const gr = await runBookingGuardrail({
      bookingEnabled,
      bookingLink,
      tenantId: tenant.id,
      canal: "whatsapp",
      contacto: contactoNorm,
      idioma: idiomaDestino,
      userText: userInput,
      ctx: convoCtx,
      messageId,
      detectedIntent: detectedIntent || INTENCION_FINAL_CANONICA || null,
      bookingFlow: bookingFlowMvp,
    });

    if (gr.result?.ctxPatch) transition({ patchCtx: gr.result.ctxPatch });

    if (gr.hit && gr.result?.handled) {
      await setConversationStateCompat(tenant.id, canal, contactoNorm, {
        activeFlow,
        activeStep,
        context: convoCtx,
      });

      return await replyAndExit(
        gr.result.reply || (idiomaDestino === "en" ? "Ok." : "Perfecto."),
        "booking_guardrail:sm_fallback",
        "agendar_cita"
      );
    }

    const composed = await answerWithPromptBase({
      tenantId: tenant.id,
      promptBase: promptBaseMem,
      userInput,
      history, // ✅ aquí
      idiomaDestino,
      canal: "whatsapp",
      maxLines: MAX_WHATSAPP_LINES,
      fallbackText: getBienvenidaPorCanal("whatsapp", tenant, idiomaDestino),
    });

    setReply(composed.text, "sm-fallback");
    await finalizeReply();
    return;
  }
}