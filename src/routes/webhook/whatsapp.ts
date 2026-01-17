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
) {
  try {
    const r = await pool.query(
      `
      INSERT INTO clientes (tenant_id, canal, contacto, created_at, updated_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      ON CONFLICT (tenant_id, canal, contacto)
      DO UPDATE SET updated_at = NOW()
      RETURNING id
      `,
      [tenantId, canal, contacto]
    );

    console.log("✅ ensureClienteBase ok", {
      tenantId,
      canal,
      contacto,
      clienteId: r.rows?.[0]?.id,
    });
  } catch (e: any) {
    console.warn("⚠️ ensureClienteBase FAILED", {
      tenantId,
      canal,
      contacto,
      msg: e?.message,
      code: e?.code,
      detail: e?.detail,
      constraint: e?.constraint,
    });
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

  // 👉 detectar si el mensaje es solo numérico (para usar idioma previo)
  const isNumericOnly = /^\s*\d+\s*$/.test(userInput);

  // 👉 idioma base del tenant (fallback)
  const tenantBase: "es" | "en" = normalizeLang(tenant?.idioma || "es");

  // ✅ idiomaDestino debe existir ANTES de armar 'event'
  let idiomaDestino: "es" | "en" = tenantBase;

  const origen = turn.origen;

  const numero = turn.numero;
  const numeroSinMas = turn.numeroSinMas;

  const fromNumber = turn.fromNumber;
  const contactoNorm = turn.contactoNorm;

  if (isNumericOnly) {
    idiomaDestino = await getIdiomaClienteDB(tenant.id, canal, turn.contactoNorm, tenantBase);
    console.log(`🌍 idiomaDestino= ${idiomaDestino} fuente= DB (solo número)`);
  } else {
    let detectado: string | null = null;
    try { detectado = normLang(await detectarIdioma(userInput)); } catch {}

    const normalizado: "es" | "en" = normalizeLang(detectado || tenantBase);

    await upsertIdiomaClienteDB(tenant.id, canal, turn.contactoNorm, normalizado);

    idiomaDestino = normalizado;
    console.log(`🌍 idiomaDestino= ${idiomaDestino} fuente= userInput`);
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

  // ✅ Prompt base disponible temprano (para SM y gates)
  const promptBase = getPromptPorCanal('whatsapp', tenant, idiomaDestino);
  let promptBaseMem = promptBase;

  console.log("🔎 numero normalizado =", { numero, numeroSinMas });

  // 🧱 FIX CRÍTICO: crea la fila base del cliente si no existe
  await ensureClienteBase(tenant.id, canal, contactoNorm);

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

  const awaiting = (convoCtx as any)?.awaiting || activeStep || null;

  console.log("🧠 convo_state (start) =", {
    activeFlow,
    activeStep,
    convoCtx,
  });

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

  async function replyAndExit(text: string, source: string, intent?: string | null) {
    setReply(text, source, intent);
    await finalizeReply();
    return;
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

  let replied = false;

  function setReply(text: string, source: string, intent?: string | null) {
    replied = true;
    handled = true;
    reply = text;
    replySource = source;
    if (intent !== undefined) lastIntent = intent;
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
      // ✅ FOLLOW-UP (programar 1 pendiente si aplica)
      try {
        await scheduleFollowUpIfEligible({
          tenant,
          canal,                 // "whatsapp"
          contactoNorm,
          idiomaDestino,
          intFinal: finalIntent || null,
          nivel: finalNivel,
          userText: userInput,
        });
      } catch (e: any) {
        console.warn("⚠️ scheduleFollowUpIfEligible failed:", e?.message);
      }
    } catch (e: any) {
      console.warn("⚠️ recordSalesIntent(final) failed:", e?.message);
    }
  }

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
    fromNumber: fromNumber || contactoNorm, // ✅ usa fromNumber real
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
      emotion,                 // <- tu variable actual
      intent: detectedIntent,  // <- ya calculada arriba
      interestLevel: detectedInterest,
    });

    // Persistimos señales para SM/LLM/Debug
    if (trig?.ctxPatch) {
      transition({ patchCtx: trig.ctxPatch });
    }

    // Si requiere handoff, respondemos y salimos (Single Exit)
    if (trig?.action === "handoff_human" && trig.replyOverride) {
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
  // 👋 GREETING GATE: si es saludo puro, responde con la bienvenida del tenant
  // ===============================
  if (saludoPuroRegex.test(userInput)) {
    const bienvenida = getBienvenidaPorCanal("whatsapp", tenant, idiomaDestino);

    // (Opcional) actualiza estado para que quede registrado que saludó
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
    const bk = await bookingFlowMvp({
      tenantId: tenant.id,
      canal: "whatsapp",
      contacto: contactoNorm,
      idioma: idiomaDestino,
      userText: userInput,
      ctx: convoCtx,
      bookingLink,
    });

    // 1) Siempre aplica patch si existe (pero NO respondas por eso)
    if (bk?.ctxPatch) {
      transition({ patchCtx: bk.ctxPatch });
    }

    // 2) Solo responde si realmente handled=true
    if (bk?.handled) {
      return await replyAndExit(
        bk.reply || (idiomaDestino === "en" ? "Ok." : "Perfecto."),
        "booking_flow",
        detectedIntent
      );
    }
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
      fromNumber: fromNumber || contactoNorm, // ✅ usa fromNumber real
      excludeMessageId: messageId,
      limit: 12,
    });

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
    fromNumber: fromNumber || contactoNorm, // ✅ usa fromNumber real
    excludeMessageId: messageId,
    limit: 12,
  });

  // ===============================
  // ✅ FALLBACK ÚNICO (solo si SM no respondió)
  // ===============================
  if (!replied) {
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