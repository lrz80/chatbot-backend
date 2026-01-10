// backend/src/routes/webhook/whatsapp.ts

import { Router, Request, Response } from 'express';
import pool from '../../lib/db';
import OpenAI from 'openai';
import twilio from 'twilio';
import { buildDudaSlug, isDirectIntent, normalizeIntentAlias } from '../../lib/intentSlug';
import { getPromptPorCanal, getBienvenidaPorCanal } from '../../lib/getPromptPorCanal';
import { detectarIdioma } from '../../lib/detectarIdioma';
import { traducirMensaje } from '../../lib/traducirMensaje';
import { buscarRespuestaSimilitudFaqsTraducido } from '../../lib/respuestasTraducidas';
import { enviarWhatsApp, enviarWhatsAppVoid } from "../../lib/senders/whatsapp";
import {
  yaExisteComoFaqSugerida,
  yaExisteComoFaqAprobada,
  normalizarTexto
} from '../../lib/faq/similaridadFaq';

// ⬇️ Importa también esIntencionDeVenta para contar ventas correctamente
import { detectarIntencion, esIntencionDeVenta } from '../../lib/detectarIntencion';

import { fetchFaqPrecio } from '../../lib/faq/fetchFaqPrecio';
import { buscarRespuestaPorIntencion } from "../../services/intent-matcher";
import { extractEntitiesLite } from '../../utils/extractEntitiesLite';
import { getFaqByIntent } from "../../utils/getFaqByIntent";
import { answerMultiIntent, detectTopIntents } from '../../utils/multiIntent';
import type { Canal } from '../../lib/detectarIntencion';
import { tidyMultiAnswer } from '../../utils/tidyMultiAnswer';
import { antiPhishingGuard } from "../../lib/security/antiPhishing";
import {
  saludoPuroRegex,
  smallTalkRegex,
  buildSaludoConversacional,
  buildSaludoSmallTalk,
  graciasPuroRegex,
  buildGraciasRespuesta,
} from '../../lib/saludosConversacionales';
import { answerWithPromptBase } from '../../lib/answers/answerWithPromptBase';
import { getIO } from '../../lib/socket';
import { incrementarUsoPorCanal } from '../../lib/incrementUsage';
import { getOrCreateBookingSession, updateBookingSession } from "../../services/bookingSession";
import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import { rememberTurn } from "../../lib/memory/rememberTurn";
import { rememberFacts } from "../../lib/memory/rememberFacts";
import { getMemoryValue } from "../../lib/clientMemory";
import { refreshFactsSummary } from "../../lib/memory/refreshFactsSummary";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  getConversationState,
  setConversationState,
  getOrInitConversationState,
  clearConversationState
} from "../../lib/conversationState";

// Puedes ponerlo debajo de los imports
export type WhatsAppContext = {
  tenant?: any;
  canal?: string;
  origen?: "twilio" | "meta";
};

const PRICE_REGEX = /\b(precio|precios|costo|costos|cuesta|cuestan|tarifa|tarifas|cuota|mensualidad|membres[ií]a|membership|price|prices|cost|fee|fees)\b/i;
const MATCHER_MIN_OVERRIDE = 0.85; // exige score alto para sobreescribir una intención "directa"

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

const INTENT_THRESHOLD = Math.min(
  0.95,
  Math.max(0.30, Number(process.env.INTENT_MATCH_THRESHOLD ?? 0.55))
);

const BOOKING_ENABLED =
  String(process.env.BOOKING_ENABLED || "false").toLowerCase() === "true";

const router = Router();
const MessagingResponse = twilio.twiml.MessagingResponse;

const INTENTS_DIRECT = new Set([
  'interes_clases',
  'precio',
  'horario',
  'ubicacion',
  'reservar',
  'comprar',
  'confirmar',
  'clases_online',
  'saludo',          // 👈 NUEVO
  'agradecimiento',  // 👈 NUEVO
]);

// Intenciones que deben ser únicas por tenant/canal
const INTENT_UNIQUE = new Set([
  'precio','horario','ubicacion','reservar','comprar','confirmar','interes_clases','clases_online'
]);

// Normalizadores
const normLang = (code?: string | null) => {
  if (!code) return null;
  const base = code.toString().split(/[-_]/)[0].toLowerCase();
  return base === 'zxx' ? null : base; // zxx = sin lenguaje
};
const normalizeLang = (code?: string | null): 'es' | 'en' =>
  (code || '').toLowerCase().startsWith('en') ? 'en' : 'es';

function getConfigDelayMinutes(cfg: any, fallbackMin = 60) {
  const m = Number(cfg?.minutos_espera);
  if (Number.isFinite(m) && m > 0) return m;
  return fallbackMin;
}

// BOOKING HELPERS
const BOOKING_TZ = "America/New_York";

// Parse robusto: convierte texto libre a Date en TZ NY
function parseDateTimeFromText(
  text: string,
  idiomaDestino: string
): Date | null {
  try {
    const ref = new Date();

    // Normaliza idioma (por si llega "es-419", "en-US", etc.)
    const lang = String(idiomaDestino || "es").toLowerCase().startsWith("es")
      ? "es"
      : "en";

    // ✅ Si chrono.es no existe en runtime, hacemos fallback a chrono.parse
    const parser =
      lang === "es" && (chrono as any)?.es?.parse
        ? (chrono as any).es
        : chrono;

    const results = parser.parse(text, ref);

    if (!results?.length) return null;

    const dt = results[0].start?.date?.();
    if (!dt) return null;

    const lux = DateTime.fromJSDate(dt, { zone: BOOKING_TZ });
    if (!lux.isValid) return null;

    return lux.toJSDate();
  } catch (e) {
    console.warn("[BOOKING] parseDateTimeFromText failed:", {
      text,
      idiomaDestino,
      err: (e as any)?.message,
    });
    return null;
  }
}

async function isSlotAvailable(opts: {
  tenantId: string;
  start: Date;
  end: Date;
}) {
  const { tenantId, start, end } = opts;

  // overlap: start < existing_end AND end > existing_start
  const { rows } = await pool.query(
    `
    SELECT 1
    FROM appointments
    WHERE tenant_id = $1
      AND status IN ('pending','confirmed','attended')
      AND start_time < $3
      AND end_time > $2
    LIMIT 1
    `,
    [tenantId, start.toISOString(), end.toISOString()]
  );

  return rows.length === 0;
}

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

async function translateCTAIfNeeded(
  cta: { cta_text: string; cta_url: string } | null,
  idiomaDestino: 'es'|'en'
) {
  if (!cta) return null;
  let txt = (cta.cta_text || '').trim();
  try {
    // si el idioma destino es EN y el CTA no parece inglés, tradúcelo;
    // (o traduce siempre a idiomaDestino si prefieres)
    const lang = await detectarIdioma(txt).catch(() => null);
    if (lang && lang !== 'zxx' && ((idiomaDestino === 'en' && !/^en/i.test(lang)) ||
                                   (idiomaDestino === 'es' && !/^es/i.test(lang)))) {
      txt = await traducirMensaje(txt, idiomaDestino);
    } else if (!lang) {
      // sin detección: fuerza a idiomaDestino por seguridad
      txt = await traducirMensaje(txt, idiomaDestino);
    }
  } catch {}
  return { cta_text: txt, cta_url: cta.cta_url };
}

// ⬇️ Helper único para registrar INTENCIÓN DE VENTA (evita duplicar lógica)
async function recordSalesIntent(
  tenantId: string,
  contacto: string,
  canal: string,
  mensaje: string,
  intencion: string,
  nivel_interes: number,
  messageId: string | null
) {
  if (!messageId) return;
  if (!esIntencionDeVenta(intencion)) return; // solo cuenta si es venta
  try {
    await pool.query(
      `INSERT INTO sales_intelligence
        (tenant_id, contacto, canal, mensaje, intencion, nivel_interes, message_id, fecha)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (tenant_id, contacto, canal, message_id) DO NOTHING`,
      [tenantId, contacto, canal, mensaje, intencion, nivel_interes, messageId]
    );

  } catch (e) {
    console.warn('⚠️ No se pudo insertar en sales_intelligence (WA):', e);
  }
}

function pickIntentForCTA(
  opts: {
    canonical?: string | null;     // INTENCION_FINAL_CANONICA
    matcher?: string | null;       // respIntent.intent
    firstOfTop?: string | null;    // top[0]?.intent en multi-intent
    fallback?: string | null;      // intenCanon u otras
    prefer?: string | null;        // fuerza (ej. 'precio' si el user pidió precios)
  }
) {
  const cand = [
    opts.prefer?.trim().toLowerCase(),
    opts.matcher?.trim().toLowerCase(),
    opts.firstOfTop?.trim().toLowerCase(),
    opts.canonical?.trim().toLowerCase(),
    opts.fallback?.trim().toLowerCase()
  ];
  return cand.find(Boolean) || null;
}

function appendCTAWithCap(
  text: string,
  cta: { cta_text: string; cta_url: string } | null
) {
  if (!cta) return text;
  const extra = `\n\n${cta.cta_text}: ${cta.cta_url}`;
  const lines = text.split('\n'); // ❗️ no filtramos vacías
  const limit = Math.max(0, MAX_WHATSAPP_LINES - 2); // deja 2 líneas para CTA
  if (lines.length > limit) {
    return lines.slice(0, limit).join('\n') + extra;
  }
  return text + extra;
}

// Evita enviar duplicado si Twilio reintenta el webhook
async function safeEnviarWhatsApp(
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
      console.log('⏩ safeEnviarWhatsApp: ya reservado/enviado este outbound message_id. No envío ni cuento.');
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
    console.error('❌ safeEnviarWhatsApp error:', e);
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
}) {
  const { tenantId, canal, fromNumber, messageId, content } = opts;

  try {
    const finalMessageId = messageId ? `${messageId}-bot` : null;

    const { rows } = await pool.query(
      `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
       VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
       ON CONFLICT (tenant_id, message_id) DO NOTHING
       RETURNING id, timestamp, role, content, canal, from_number`,
      [tenantId, content, canal, fromNumber || 'anónimo', finalMessageId]
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
}) {
  const { tenantId, canal, fromNumber, messageId, content } = opts;

  if (!messageId) return; // sin messageId no deduplicas bien

  try {
    const { rows } = await pool.query(
      `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
       VALUES ($1, 'user', $2, NOW(), $3, $4, $5)
       ON CONFLICT (tenant_id, message_id) DO NOTHING
       RETURNING id, timestamp, role, content, canal, from_number`,
      [tenantId, content, canal, fromNumber || 'anónimo', messageId]
    );

    const inserted = rows[0];
    if (!inserted) return;

    const io = getIO();
    if (!io) return;

    io.emit('message:new', {
      id: inserted.id,
      created_at: inserted.timestamp,
      timestamp: inserted.timestamp,
      role: inserted.role,
      content: inserted.content,
      canal: inserted.canal,
      from_number: inserted.from_number,
    });
  } catch (e) {
    console.warn('⚠️ No se pudo registrar mensaje user + socket:', e);
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
    const params: any[] = [tenantId, canal, fromNumber, limit];

    const excludeSql = excludeMessageId ? `AND message_id <> $5` : '';
    if (excludeMessageId) params.push(excludeMessageId);

    const { rows } = await pool.query(
      `
      SELECT role, content
      FROM messages
      WHERE tenant_id = $1
        AND canal = $2
        AND from_number = $3
        ${excludeSql}
        AND role IN ('user','assistant')
      ORDER BY timestamp DESC
      LIMIT $4
      `,
      params
    );

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

  // ✅ Decision metadata (backend NO habla, solo decide)
  let nextAction: {
    type: string;
    decision?: "yes" | "no";
    kind?: string | null;
    intent?: string | null;
  } | null = null;

  // Datos básicos del webhook
  const to = body?.To || '';
  const from = body?.From || '';
  const userInput = body?.Body || '';
  const messageId =
    body?.MessageSid ||
    body?.SmsMessageSid ||
    body?.MetaMessageId ||
    null;

  const origen: "twilio" | "meta" =
    context?.origen ??
    (context?.canal && context.canal !== "whatsapp" ? "meta" : null) ??
    ((body?.MessageSid || body?.SmsMessageSid) ? "twilio" : "meta");

  // Números “limpios”
  const numero      = to.replace('whatsapp:', '').replace('tel:', '');   // número del negocio
  const fromNumber  = from.replace('whatsapp:', '').replace('tel:', ''); // número del cliente

  // ✅ contacto NORMALIZADO ÚNICO para DB/estado/dedupe
  const contactoNorm = String(fromNumber || "").replace(/[^\d+]/g, "");

  // Normaliza variantes con / sin "+" para que coincida aunque en DB esté "1555..." o "+1555..."
  const numeroSinMas = numero.replace(/^\+/, '');
  console.log('🔎 numero normalizado =', { numero, numeroSinMas });

  // 👉 1) intenta usar el tenant que viene en el contexto (Meta / otros canales)
  let tenant = context?.tenant as any | undefined;

  // 👉 2) si no viene en el contexto (caso Twilio), haz el lookup por número
  if (!tenant) {
    if (origen === "twilio") {
      const tenantRes = await pool.query(
        `
        SELECT *
          FROM tenants
        WHERE REPLACE(LOWER(twilio_number),'whatsapp:','') = $1
            OR REPLACE(LOWER(twilio_number),'whatsapp:','') = $2
        LIMIT 1
        `,
        [numero.toLowerCase(), numeroSinMas.toLowerCase()]
      );

      tenant = tenantRes.rows[0];
    } else {
      const tenantRes = await pool.query(
        `
        SELECT *
          FROM tenants
        WHERE REPLACE(LOWER(whatsapp_phone_number_id::text),'whatsapp:','') = $1
        LIMIT 1
        `,
        [numero.toLowerCase()]
      );

      tenant = tenantRes.rows[0];
    }
  }

  if (!tenant) {
    console.log('⛔ No se encontró tenant para este número de WhatsApp.');
    return;
  }

  // // canal puede venir en el contexto (meta/preview) o por defecto 'whatsapp'
  const canal: Canal = (context?.canal as Canal) || 'whatsapp';

  // 🧱 FIX CRÍTICO: crea la fila base del cliente si no existe
  await ensureClienteBase(tenant.id, canal, contactoNorm);

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
  // 🧭 ROUTER POR STEP (mínimo, backend solo decide)
  // ===============================
  if (activeFlow === "generic_sales") {
    switch (activeStep) {

      case "start": {
        transition({ step: "need" });
        return await replyAndExit(
          "",                 // backend mudo
          "start-greeting",
          "saludo"
        );
      }

      case "need": {
        transition({
          step: "details",
          patchCtx: {
            last_bot_action: "ask_need",
            expected_input: "user_goal",
          },
        });

        return await replyAndExit(
          "",
          "need-ask",
          "lead"
        );
      }

      // ⬇️ Si no coincide ningún step, NO decides aquí
      default:
        break;
    }
  }

  // ===============================
  // 🔄 SALUDO – detección, guard y decisión (backend NO habla)
  // ===============================
  const normalizedInput = (userInput || "").trim().toLowerCase();

  const isGreeting =
    normalizedInput === "hola" ||
    normalizedInput === "hello" ||
    normalizedInput === "hi" ||
    normalizedInput === "hey" ||
    normalizedInput === "buenas" ||
    normalizedInput === "buenos dias" ||
    normalizedInput === "buenas tardes" ||
    normalizedInput === "buenas noches";

  // 🚫 Guard: ignorar SOLO si es saludo repetido inmediato (no loops)
  if (
    isGreeting &&
    convoCtx?.last_bot_action === "handled_greeting" &&
    convoCtx?.last_user_text === normalizedInput
  ) {
    console.log("🚫 Saludo repetido inmediato ignorado");
    return;
  }

  // 👋 Caso: saludo válido → SOLO DECIDIR (mover estado), backend mudo
  if (isGreeting) {
    console.log("👋 Saludo detectado → reset/transition (backend mudo)");

    transition({
      flow: "generic_sales",
      step: "need",
      patchCtx: {
        reset_reason: "greeting",
        last_bot_action: "handled_greeting",
        last_user_text: normalizedInput,
        last_reply_source: "saludo",
      },
    });

    // backend mudo: el copy lo debe renderizar tu capa de UI por replySource/step
    return await replyAndExit("", "saludo", "saludo");
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

  if (status !== "enabled") {
    console.log("⛔ WhatsApp deshabilitado para tenant:", tenant.id, "status=", status);
    return;
  }

  // Si llega por Twilio pero el tenant está en Cloud API → ignorar (evita doble respuesta)
  if (origen === "twilio" && mode !== "twilio") {
    console.log("⏭️ Ignoro webhook Twilio: tenant en cloudapi. tenantId=", tenant.id);
    return;
  }

  // Si llega por Meta pero el tenant está en Twilio → ignorar
  if (origen === "meta" && mode !== "cloudapi") {
    console.log("⏭️ Ignoro webhook Meta: tenant en twilio. tenantId=", tenant.id);
    return;
  }

  // Si no hay membresía activa: no respondas
  if (!tenant.membresia_activa) {
    console.log(`⛔ Membresía inactiva para tenant ${tenant.name || tenant.id}. No se responderá.`);
    return;
  }

  // 👉 detectar si el mensaje es solo numérico (para usar idioma previo)
  const isNumericOnly = /^\s*\d+\s*$/.test(userInput);

  // 👉 idioma base del tenant (fallback)
  const tenantBase: 'es' | 'en' = normalizeLang(tenant?.idioma || 'es');

  let idiomaDestino: 'es'|'en';

  if (isNumericOnly) {
    idiomaDestino = await getIdiomaClienteDB(tenant.id, canal, contactoNorm, tenantBase);
    console.log(`🌍 idiomaDestino= ${idiomaDestino} fuente= DB (solo número)`);
  } else {
    let detectado: string | null = null;
    try { detectado = normLang(await detectarIdioma(userInput)); } catch {}

    const normalizado: 'es'|'en' = normalizeLang(detectado || tenantBase);

    await upsertIdiomaClienteDB(tenant.id, canal, contactoNorm, normalizado);

    idiomaDestino = normalizado;
    console.log(`🌍 idiomaDestino= ${idiomaDestino} fuente= userInput`);
  }

  function setReply(text: string, source: string, intent?: string | null) {
    handled = true;
    reply = text;
    replySource = source;
    if (intent !== undefined) lastIntent = intent;
  }

  // ✅ DECLÁRALO AQUÍ ARRIBA (antes de finalizeReply)
  let INTENCION_FINAL_CANONICA: string | null = null;

  async function finalizeReply() {
    if (!handled || !reply) return;

    // ✅ Sender único para estado/memoria (usa el mismo criterio siempre)
    const senderKey = contactoNorm || fromNumber || "anónimo";

    // (Opcional pero recomendado) Guarda “qué se respondió” en el contexto
    // para anti-loop y trazabilidad.
    const nextCtx = {
      ...(convoCtx && typeof convoCtx === "object" ? convoCtx : {}),
      last_reply_source: replySource || null,
      last_intent: (lastIntent || INTENCION_FINAL_CANONICA || null),
      last_assistant_text: reply,
      last_user_text: userInput,
      last_turn_at: new Date().toISOString(),
    };

    // ⚠️ DECISIÓN IMPORTANTE:
    // Guarda el estado SOLO si se envió ok.
    // (Si falla el envío, no avances el hilo para no desincronizar conversación real vs DB.)
    const ok = await safeEnviarWhatsApp(tenant.id, canal, messageId, fromNumber, reply);

    if (ok) {
      // ===============================
      // 🧠 1) Guardar conversation_state (UNA SOLA VEZ)
      // ===============================
      await setConversationState(tenant.id, canal, senderKey, {
        activeFlow: activeFlow || "generic_sales",
        activeStep: activeStep || "start",
        context: nextCtx,
      });

      // ===============================
      // 💾 2) Guardar mensaje + emitir
      // ===============================
      await saveAssistantMessageAndEmit({
        tenantId: tenant.id,
        canal,
        fromNumber: senderKey,
        messageId,
        content: reply,
      });

      // ===============================
      // 🧠 3) Memoria LLM (si aplica)
      // ===============================
      await rememberAfterReply({
        tenantId: tenant.id,
        senderId: senderKey,
        idiomaDestino,
        userText: userInput,
        assistantText: reply,
        lastIntent: lastIntent || INTENCION_FINAL_CANONICA || null,
      });

      // ✅ Mantén tus variables en sync
      convoCtx = nextCtx;
    } else {
      console.warn("⚠️ finalizeReply: safeEnviarWhatsApp falló; no guardo assistant/memoria/estado.", { replySource });
    }
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

  await saveUserMessageAndEmit({
    tenantId: tenant.id,
    canal,
    fromNumber: contactoNorm || fromNumber || 'anónimo',
    messageId,
    content: userInput || '',
  });

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

  // ✅ Prompt base disponible para TODO el flujo (incluye la rama de pago)
  const promptBase = getPromptPorCanal('whatsapp', tenant, idiomaDestino);

  // ===============================
  // ✅ MEMORIA (3): Retrieval → inyectar memoria del cliente en el prompt
  // ===============================
  let promptBaseMem = promptBase;

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

  } catch (e) {
    console.warn("⚠️ No se pudo cargar memoria (getMemoryValue):", e);
  }

  // ===============================
  // ✅ CONTROL DE ESTADO (PAGO / HUMANO) - PRIORIDAD MÁXIMA (WHATSAPP)
  // ===============================
  {
    const tenantId = tenant.id;
    const canalEnvio = canal;      // 'whatsapp'
    const senderId = contactoNorm;

    const state = await getConversationState(
      tenant.id,
      canalEnvio,
      senderId
    );
    console.log("🧩 conversation_state =", state);

    const { rows: clienteRows } = await pool.query(
      `SELECT estado, human_override, nombre, email, telefono, pais, segmento, info_explicada
        FROM clientes
        WHERE tenant_id = $1 AND canal = $2 AND contacto = $3
        LIMIT 1`,
      [tenantId, canalEnvio, senderId]
    );

    const cliente = clienteRows[0] || null;

    const LINK_REQUEST_REGEX = /\b(link|enlace|pagar|pago|stripe|checkout|payment\s+link)\b/i;

    // 0) Si ya tenemos datos y está esperando pago, y pide link → reenvía link (sin pedir datos otra vez)
    if ((cliente?.estado || '').toLowerCase() === 'esperando_pago' && LINK_REQUEST_REGEX.test(userInput)) {
      const paymentLink = extractPaymentLinkFromPrompt(promptBase);

      const mensajePago =
        idiomaDestino === 'en'
          ? (
              paymentLink
                ? `Here’s the payment link:\n${paymentLink}\nAfter you pay, text “PAGO REALIZADO”.`
                : `I don’t have the payment link configured. Please ask the team to share it with you.`
            )
          : (
              paymentLink
                ? `Aquí tienes el link de pago:\n${paymentLink}\nCuando pagues, escríbeme “PAGO REALIZADO”.`
                : `No tengo el link de pago configurado. Pídeselo al equipo para enviártelo.`
            );

      transition({
        flow: "generic_sales",
        step: "close",
        patchCtx: {
          last_bot_action: "sent_payment_link",
          payment_link_sent: true,
        },
      });

      return await replyAndExit(mensajePago, "pago-link", "pago");
    }

    // 1) Si humano tomó la conversación → SILENCIO TOTAL
    if (cliente?.human_override === true) {
      console.log('🤝 [WA] Conversación tomada por humano. Bot NO responde:', senderId);
      return;
    }

    // 2) Si está en pago_en_confirmacion → SILENCIO TOTAL
    if ((cliente?.estado || '').toLowerCase() === 'pago_en_confirmacion') {
      console.log('💳 [WA] Pago en confirmación. Bot en silencio:', senderId);
      return;
    }

    // 3) Si usuario confirma pago → guardar estado + human_override y responder SOLO el mensaje fijo
    if (PAGO_CONFIRM_REGEX.test(userInput)) {
      await pool.query(
        `INSERT INTO clientes (tenant_id, canal, contacto, estado, human_override, updated_at)
        VALUES ($1, $2, $3, 'pago_en_confirmacion', true, now())
        ON CONFLICT (tenant_id, canal, contacto)
        DO UPDATE SET estado='pago_en_confirmacion', human_override=true, updated_at=now()`,
        [tenantId, canalEnvio, senderId]
      );

      const msgPago =
        idiomaDestino === 'en'
          ? "Perfect 👍\nWe’ll confirm your payment and someone from the team will contact you to activate your account."
          : "Perfecto 👍\nVamos a confirmar tu pago y una persona del equipo se pondrá en contacto contigo para la activación de tu cuenta.";

      transition({
        flow: "generic_sales",
        step: "close",
        patchCtx: {
          guard: "payment",
          payment_status: "confirmed",
          last_bot_action: "sent_payment_confirmation",
        },
      });

      return await replyAndExit(msgPago, "pago-confirm", "pago");
    }

    // 4) Si el usuario manda datos (email + telefono + nombre + pais) → guardar y enviar link UNA SOLA VEZ
    const parsed = parseDatosCliente(userInput);
    if (parsed) {
      const estadoActual = (cliente?.estado || '').toLowerCase();

      await pool.query(
        `INSERT INTO clientes (tenant_id, canal, contacto, nombre, email, telefono, pais, segmento, estado, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'lead'), 'esperando_pago', now())
        ON CONFLICT (tenant_id, canal, contacto)
        DO UPDATE SET
          nombre   = COALESCE(EXCLUDED.nombre, clientes.nombre),
          email    = COALESCE(EXCLUDED.email,  clientes.email),
          telefono = COALESCE(EXCLUDED.telefono, clientes.telefono),
          pais     = COALESCE(EXCLUDED.pais, clientes.pais),
          estado   = 'esperando_pago',
          updated_at = now()`,
        [tenantId, canalEnvio, senderId, parsed.nombre, parsed.email, parsed.telefono, parsed.pais, cliente?.segmento || null]
      );

      const pideLink = /\b(link|enlace|pago|stripe)\b/i.test(userInput);

      if (estadoActual !== 'esperando_pago' || pideLink) {
        const paymentLink = extractPaymentLinkFromPrompt(promptBase); // 👈 del prompt

        const mensajePago =
          idiomaDestino === 'en'
            ? (
                paymentLink
                  ? `Thanks. I already have your details.\nYou can complete the payment here:\n${paymentLink}\nAfter you pay, text “PAGO REALIZADO” to continue.`
                  : "Thanks. I already have your details.\nYou can complete the payment using the link I shared with you.\nAfter you pay, text “PAGO REALIZADO” to continue."
              )
            : (
                paymentLink
                  ? `Gracias. Ya tengo tus datos.\nPuedes completar el pago aquí:\n${paymentLink}\nCuando realices el pago, escríbeme “PAGO REALIZADO” para continuar.`
                  : "Gracias. Ya tengo tus datos.\nPuedes completar el pago usando el enlace que te compartí.\nCuando realices el pago, escríbeme “PAGO REALIZADO” para continuar."
              );

        transition({
          flow: "generic_sales",
          step: "details",
          patchCtx: {
            guard: "payment",
            awaiting_field: "payment_details", // o el campo específico que pidas en mensajePago
            last_bot_action: "requested_payment_details",
          },
        });

        return await replyAndExit(mensajePago, "pago-datos", "pago");
      } // ✅ cierra if (estadoActual...)
    } // ✅ cierra if (parsed)
  } // ✅ cierra el bloque CONTROL DE ESTADO

  if (handled) { await finalizeReply(); return; }

  // ========================================
  // ✅ STATE GATE (YES / NO)
  // backend NO responde, SOLO decide
  // ========================================
  const state = await getConversationState(
    tenant.id,
    canal,
    contactoNorm
  );

  if (state?.active_flow === "yesno" && state?.active_step === "awaiting_confirmation") {
    const t = (userInput || "").trim().toLowerCase();

    const isYes = /^(si|sí|ok|dale|claro|yes|yep|sure)$/i.test(t);
    const isNo = /^(no|nope|nah)$/i.test(t);

    if (isYes || isNo) {
      nextAction = {
        type: "yesno_resolved",
        decision: isYes ? "yes" : "no",
        kind: (state.context as any)?.kind || null,
        intent: (state.context as any)?.intent || null,
      };

      // limpiamos el estado para no quedar pegados
      await clearConversationState(
        tenant.id,
        canal,
        contactoNorm
      );
    }
  }

  console.log("🟠 [WA] Entrando al pipeline NORMAL (sin FlowEngine)", {
    tenantId: tenant.id,
    canal,
    contactoNorm,
    messageId,
    userInput,
    origen,
    mode,
  });

if (BOOKING_ENABLED) {
  // BOOKING FLOW (FASE 1) - estado WAITING_DATETIME
  try {
    const session = await getOrCreateBookingSession({
      tenantId: tenant.id,
      channel: "whatsapp",
      contact: contactoNorm,
    });

    if (session?.state === "WAITING_DATETIME") {
      const parsed = parseDateTimeFromText(userInput, idiomaDestino);

      if (!parsed) {
        const reply =
          idiomaDestino === "en"
            ? "I didn’t catch the date and time. Please send it like: Dec 15 at 3pm."
            : "No pude entender la fecha y hora. Envíamela así: 15 dic a las 3pm.";

        transition({
          flow: "generic_booking",
          step: "awaiting_datetime",
          patchCtx: {
            last_bot_action: "asked_datetime",
            awaiting_field: "datetime",
            booking: {
              ...(convoCtx?.booking || {}),
              datetime: null,
            },
          },
        });

        return await replyAndExit(reply, "booking-waiting-datetime-no-parse", "agendar");
      }

      // Duración: por ahora 60min
      const durationMin = 60;
      const start = DateTime.fromJSDate(parsed, { zone: BOOKING_TZ });
      const end = start.plus({ minutes: durationMin });

      // No permitir pasado
      if (start < DateTime.now().setZone(BOOKING_TZ)) {
        const reply =
          idiomaDestino === "en"
            ? "That time is in the past. What date and time would you like instead?"
            : "Esa hora ya pasó. ¿Qué fecha y hora quieres en su lugar?";

        transition({
          flow: "generic_booking",
          step: "awaiting_datetime",
          patchCtx: {
            booking_status: "waiting_datetime",
            last_bot_action: "asked_datetime_again",
            last_datetime_invalid_reason: "past",
          },
        });

        return await replyAndExit(reply, "booking-waiting-datetime-past", "agendar");
      }

      const ok = await isSlotAvailable({
        tenantId: tenant.id,
        start: start.toJSDate(),
        end: end.toJSDate(),
      });

      if (!ok) {
        const reply =
          idiomaDestino === "en"
            ? "That time is not available. Please send another date and time."
            : "Esa hora no está disponible. Envíame otra fecha y hora.";

        transition({
          flow: "generic_booking",
          step: "awaiting_datetime",
          patchCtx: {
            awaiting_field: "date_time",
            last_bot_action: "asked_date_time",
            booking_status: "datetime_not_available",
          },
        });

        return await replyAndExit(reply, "booking-waiting-datetime-not-available", "agendar");
      }

      // Guardar en sesión y pasar a pedir datos del cliente
      await updateBookingSession({
        tenantId: tenant.id,
        channel: "whatsapp",
        contact: contactoNorm,
        patch: {
          state: "WAITING_CONTACT",
          desired_start_time: start.toJSDate(),
          desired_end_time: end.toJSDate(),
        },
      });

      const formatted =
        idiomaDestino === "en"
          ? start.toLocaleString(DateTime.DATETIME_MED)
          : start.setLocale("es").toLocaleString(DateTime.DATETIME_MED);

      const reply =
        idiomaDestino === "en"
          ? `Perfect. I have availability for ${formatted}. What's your full name and email?`
          : `Perfecto. Hay disponibilidad para ${formatted}. ¿Cuál es tu nombre y tu email?`;

      transition({
        flow: "generic_sales",
        step: "collecting_details",
        patchCtx: {
          awaiting_field: "date_time",
          booking_status: "waiting_datetime",
          last_bot_action: "asked_datetime_available",
        },
      });

      return await replyAndExit(reply, "booking-waiting-datetime-available", "agendar");
    }
  } catch (e) {
    console.warn("⚠️ Booking WAITING_DATETIME handler failed:", e);
  }
}

if (BOOKING_ENABLED) {
  // GATILLO TEMPORAL DE CITA (FASE 1)
  try {
    const lowerMsg = (userInput || "").toLowerCase();

    const wantsBooking =
      /\b(cita|agendar|agenda|reservar|reservación|reservacion)\b/i.test(lowerMsg) ||
      /\b(appointment|book\s+an?\s+appointment|book\s+now|schedule\s+a\s+visit)\b/i.test(lowerMsg);

    console.log("[BOOKING] lowerMsg=", lowerMsg, "wantsBooking=", wantsBooking);

    if (wantsBooking) {
      // 1) Crear/abrir sesión de booking y pedir fecha/hora (NO crear cita aún)
      await getOrCreateBookingSession({
        tenantId: tenant.id,
        channel: "whatsapp",
        contact: contactoNorm,
      });

      await updateBookingSession({
        tenantId: tenant.id,
        channel: "whatsapp",
        contact: contactoNorm,
        patch: {
          state: "WAITING_DATETIME",
          customer_phone: fromNumber ?? null,
          // limpiamos cualquier intento previo
          desired_start_time: null,
          desired_end_time: null,
          customer_name: null,
          customer_email: null,
        },
      });

      const reply =
        idiomaDestino === "en"
          ? "Perfect. What date and time would you like for your appointment? (Example: Dec 15 at 3pm)"
          : "Perfecto. ¿Para qué fecha y hora quieres la cita? (Ejemplo: 15 dic a las 3pm)";

      // Enviar respuesta (usa el sender REAL que compila en tu proyecto)
      transition({
        flow: "generic_sales",
        step: "booking_details",
        patchCtx: {
          last_bot_action: "booking_triggered",
          booking: {
            status: "initiated",
            missing: ["date", "time"], // genérico; luego puedes personalizar por negocio
          },
        },
      });

      return await replyAndExit(reply, "booking-trigger", "agendar");
    }
  } catch (e) {
    console.warn("⚠️ Error en gatillo de booking (WA):", e);
    // si algo falla, seguimos el flujo normal
  }
}
  const idioma = idiomaDestino; // ✅ usa el idioma ya calculado
  
  function stripLeadGreetings(t: string) {
    return t
      .replace(/^\s*(hola+[\s!.,]*)?/i, '')
      .replace(/^\s*(saludos+[\s!.,]*)?/i, '')
      .replace(/^\s*(hello+|hi+|hey+)[\s!.,]*/i, '')
      .trim();
  }

  // 🧹 Cancela cualquier follow-up pendiente para este contacto al recibir nuevo mensaje
  try {
    await pool.query(
      `DELETE FROM mensajes_programados
        WHERE tenant_id = $1 AND canal = $2 AND contacto = $3 AND enviado = false`,
      [tenant.id, canal, contactoNorm]
    );
    console.log('🧽 Follow-ups pendientes limpiados (WA):', { tenantId: tenant.id, fromNumber });
  } catch (e) {
    console.warn('No se pudieron limpiar follow-ups pendientes:', e);
  }

  let faqs: any[] = [];
  try {
    const faqsRes = await pool.query(
      'SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1 AND canal = $2',
      [tenant.id, canal]
    );    
    faqs = faqsRes.rows || [];
  } catch (err) {
    console.error("❌ Error cargando FAQs:", err);
    faqs = [];
  }  

  const mensajeUsuario = normalizarTexto(stripLeadGreetings(userInput));

  const isSmallTalkOrCourtesy =
    /^(hola|hello|hi|hey|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|gracias|thanks|thank\s+you|ok|okay|vale|perfecto)\b/i
      .test(userInput.trim());

  try {
    const mensajeEs = (idiomaDestino !== 'es')
      ? await traducirMensaje(mensajeUsuario, 'es').catch(() => mensajeUsuario)
      : mensajeUsuario;

    const hitSim = await buscarRespuestaSimilitudFaqsTraducido(
      faqs,
      mensajeEs,
      idiomaDestino
    );
    console.log('[FAQ-SIM-FIRST] faqs=', faqs.length, 'idiomaDestino=', idiomaDestino);
    console.log('[FAQ-SIM-FIRST] userInput=', userInput);
    console.log('[FAQ-SIM-FIRST] mensajeEs=', mensajeEs);
    console.log('[FAQ-SIM-FIRST] hitSim=', Boolean(hitSim), 'len=', (hitSim || '').length);

    if (hitSim && hitSim.trim()) {
      // ⬇️ CTA por intención: si el texto contiene precios, preferimos "precio"
      const askedPrice = PRICE_REGEX.test(userInput);
      const intentForCTA = pickIntentForCTA({
        prefer: askedPrice ? 'precio' : null,
        fallback: INTENCION_FINAL_CANONICA || null, // si aún no existe, es null y no pasa nada
      });

      const ctaRaw = await pickCTA(tenant, intentForCTA, canal);
      const cta    = await translateCTAIfNeeded(ctaRaw, idiomaDestino);
      const outWithCTA = isSmallTalkOrCourtesy ? hitSim : appendCTAWithCap(hitSim, cta);

      transition({
        flow: "generic_sales",
        step: "answer",
        patchCtx: {
          last_bot_action: "answered_faq",
          last_faq_intent: intentForCTA || "faq",
        },
      });
      // ✅ YES / NO STATE (DEBE IR AQUÍ)
      const endsAsQuestion = /\?\s*$/.test((outWithCTA || "").trim());
      const looksLikeYesNo =
        endsAsQuestion &&
        /(te\s+gustar[ií]a|quieres|deseas|would\s+you\s+like|do\s+you\s+want)/i.test(outWithCTA || "");

      if (looksLikeYesNo) {
        await setConversationState(tenant.id, canal, contactoNorm, {
          activeFlow: "yesno",
          activeStep: "awaiting_confirmation",
          context: { kind: "followup" },
        });
      } else {
        await clearConversationState(tenant.id, canal, contactoNorm);
      }

      await finalizeReply();

      // 🔔 opcional: registrar intención + follow-up (sin forzar intent)
      try {
        const det = await detectarIntencion(userInput, tenant.id, 'whatsapp');
        const intFinal = normalizeIntentAlias((det?.intencion || '').toLowerCase());
        const nivel = det?.nivel_interes ?? 1;
        await recordSalesIntent(tenant.id, contactoNorm, canal, userInput, intFinal, nivel, messageId);
        await scheduleFollowUp(intFinal, nivel, userInput);
      } catch {}

      return;
    }
  } catch (e) {
    console.warn('⚠️ FAQ similitud (prioridad) falló; sigo pipeline normal:', e);
  }

  // Texto sin saludos al inicio para detectar "más info" y "demo"
  const cleanedForInfo = stripLeadGreetings(userInput);
  const cleanedNorm    = normalizarTexto(cleanedForInfo);

  // 🔍 CASO ESPECIAL: usuario pide "más info" de forma muy genérica
  const wantsMoreInfoEn =
    /^\s*(more\s+info|more\s+information|need\s+more\s+info(?:rmation)?|i\s+want\s+more\s+info(?:rmation)?|info\s+please|info\s+pls)\s*$/i
      .test(cleanedForInfo);

  const wantsMoreInfoEs =
    /^\s*((necesito|quiero)\s+m[aá]s\s+info(?:rmaci[oó]n)?|m[aá]s\s+info(?:rmaci[oó]n)?|info\s+por\s+favor|info\s+pls)\s*$/i
      .test(cleanedNorm);

  const tokenCount = (cleanedNorm.trim().match(/\S+/g) || []).length;
  const isShortGeneric = tokenCount <= 4; // ajusta a 5 si lo ves muy estricto

  // 🆕 Detector flexible de mensajes pidiendo "más info"
  const wantsMoreInfoDirect = [
    // ES
    "mas info",
    "más info",
    "mas informacion",
    "más información",
    "necesito mas info",
    "necesito más info",
    "quiero mas info",
    "quiero más info",
    "necesito mas informacion",
    "necesito más información",
    "quiero mas informacion",
    "quiero más información",
    "info por favor",
    "info pls",

    // EN
    "more info",
    "more information",
    "need more info",
    "need more information",
    "i want more info",
    "i want more information",
    "info please"
  ];

  const TOPIC_HINTS = [
    // precios
    "precio","precios","cost","costs","pricing","rate","rates","quote","cotiz","cotización",

    // horarios
    "horario","horarios","schedule","hours","open","close",

    // ubicación
    "direccion","dirección","address","location","ubicacion","ubicación",

    // reservas / citas
    "cita","citas","appointment","book","booking","reserve","reservation",

    // pedidos / menú
    "menu","menú","order","pedido","delivery","pickup",

    // servicios / productos
    "clase","clases","class","classes",
    "servicio","servicios","service","services",
    "producto","productos","product","products"
  ];

  const hasTopicHint = TOPIC_HINTS.some(t =>
    cleanedNorm.includes(t)
  );

  const normalizedInfo = cleanedNorm.trim();

  // 1) match por regex (frases) o por lista exacta
  const matchedByRegex =
    wantsMoreInfoEn || wantsMoreInfoEs;

  const matchedByDirect =
    wantsMoreInfoDirect.includes(normalizedInfo);

  // 2) “genérico real” = match + corto + NO trae tema
  const wantsMoreInfo =
    (matchedByRegex || matchedByDirect) &&
    isShortGeneric &&
    !hasTopicHint;

  // 🆕 Expresiones adicionales de cierre
  const trailing = /(pls?|please|por\s*fa(vor)?)/i;

  // Limpieza para comparar bien
  const msg = cleanedNorm.toLowerCase();

  // REGEX FLEXIBLE: detecta cualquier frase que contenga una palabra de la lista
  const shortInfoOnly =
    wantsMoreInfoDirect.some(k => msg.includes(k)) ||
    trailing.test(msg);

  let respuesta: string = "";

  // CTA multilenguaje para cierres consistentes
  const CTA_TXT =
    idiomaDestino === 'en'
      ? 'Is there anything else I can help you with?'
      : '¿Hay algo más en lo que te pueda ayudar?';

  if (handled) { await finalizeReply(); return; }

  // 🧩 Bloque especial: "quiero más info / need more info"
  if (wantsMoreInfo) {
    // 🔒 GATE
    try {
      const { rows } = await pool.query(
        `SELECT info_explicada FROM clientes
        WHERE tenant_id = $1 AND canal = $2 AND contacto = $3
        LIMIT 1`,
        [tenant.id, canal, contactoNorm]
      );

      if (rows[0]?.info_explicada === true) {
        const reply =
          idiomaDestino === "en"
            ? "Got it. What exactly do you want: pricing, schedule, or location?"
            : "Perfecto. ¿Qué necesitas exactamente: precios, horarios o ubicación?";

        transition({
          flow: "generic_sales",
          step: "close",
          patchCtx: {
            info_explicada: true,
            last_bot_action: "more_info_blocked",
          },
        });

        return await replyAndExit(reply, "more-info-already-explained", "pedir_info");
      } else {
        const startsWithGreeting = /^\s*(hola|hello|hi|hey|buenas(?:\s+(tardes|noches|dias|días))?|buenas|buenos\s+(dias|días))/i
          .test(userInput);

        let reply: string | null = null;

        try {
          const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

          const systemPrompt = [
            promptBaseMem,
            '',
            `Responde SIEMPRE en ${idiomaDestino === 'en' ? 'English' : 'Español'}.`,
            `Formato WhatsApp: mensajes MUY CORTOS (máx. 3-4 frases, 6-8 líneas como máximo), sin párrafos largos.`,
            `No uses viñetas, listas ni encabezados. Solo texto corrido, claro y directo.`,
            'No menciones correos, páginas web ni enlaces (no escribas "http", "www" ni "@").',
            'No des precios concretos, montos, ni duración exacta de pruebas (solo describe de forma general).',
            'Usa exclusivamente la información del negocio.',
            'No digas que eres un asistente, IA, bot, sistema o plataforma.',
            'No expliques procesos internos ni "cómo funciona".'
          ].join('\n');

          const userPromptLLM =
            idiomaDestino === 'en'
              ? `The customer asked for more information. Reply as the business.
  Write a very short message (2–3 sentences) using ONLY the business context you have.
  Do not mention that you are an assistant, AI, bot, platform, automation, system, onboarding, or how it works.
  Do not include any links, emails, or phone numbers.
  End with ONE natural follow-up question that fits this business and helps you understand what the customer needs next.`
              : `El cliente pidió más información. Responde como el negocio.
  Escribe un mensaje muy corto (2–3 frases) usando SOLO el contexto del negocio disponible.
  No menciones que eres asistente, IA, bot, plataforma, automatización, sistema, onboarding, ni expliques cómo funciona.
  No incluyas links, correos ni números.
  Termina con UNA sola pregunta natural que encaje con este negocio y te ayude a entender qué necesita el cliente.`;

          const history = await getRecentHistoryForModel({
            tenantId: tenant.id,
            canal,
            fromNumber: contactoNorm,
            excludeMessageId: messageId,  // 👈 evita duplicar el input actual
            limit: 18,
          });

          const completion = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
            temperature: 0.2,
            max_tokens: 220,
            messages: [
            // Prompt base del tenant (NO se toca)
            { role: "system" as const, content: systemPrompt },

            // 👇 Metadata de decisión (backend SOLO decide)
            ...(nextAction?.type === "yesno_resolved"
              ? [{
                  role: "system" as const,
                  content: `CONVERSATION_DECISION:
          type: yesno_resolved
          decision: ${nextAction.decision}
          kind: ${nextAction.kind || "null"}
          intent: ${nextAction.intent || "null"}

          RULES:
          - Do NOT explain infrastructure.
          - Respond naturally using the tenant business prompt.
          - Keep it short.`
                }]
              : []),

            // Historial reciente
            ...history,

            // Mensaje del usuario + instrucción ya existente
            {
              role: 'user',
              content: `MENSAJE_USUARIO:
          ${userInput}

          INSTRUCCION:
          ${userPromptLLM}`
            },
          ],
          });

          reply = completion.choices[0]?.message?.content?.trim() || null;

          // tokens
          const used = completion.usage?.total_tokens || 0;
          if (used > 0) {
            await pool.query(
              `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
              VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE), $2)
              ON CONFLICT (tenant_id, canal, mes)
              DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
              [tenant.id, used]
            );
          }
        } catch (e) {
          console.warn('⚠️ LLM (more info) falló; NO respondo aquí (sin hardcode).', e);
          reply = null;
        }

        if (reply) {
          if (startsWithGreeting) {
            const saludo = getBienvenidaPorCanal('whatsapp', tenant, idiomaDestino);
            reply = `${saludo}\n\n${reply}`;
          }

          // ✅ marcar info_explicada ANTES de responder (para que quede consistente aunque falle send)
          try {
            await pool.query(
              `INSERT INTO clientes (tenant_id, canal, contacto, info_explicada, updated_at)
              VALUES ($1, $2, $3, true, now())
              ON CONFLICT (tenant_id, canal, contacto)
              DO UPDATE SET info_explicada = true, updated_at = now()`,
              [tenant.id, canal, contactoNorm]
            );
          } catch (e) {
            console.warn("⚠️ No se pudo actualizar info_explicada:", e);
          }

          transition({
            flow: "generic_sales",
            step: "details",
            patchCtx: {
              last_bot_action: "asked_missing_info",
              awaiting_field: "service_or_details",
              last_intent: "pedir_info",
            },
          });

          await replyAndExit(reply, "more-info-llm", "pedir_info");
        
          try {
            await recordSalesIntent(tenant.id, contactoNorm, canal, userInput, 'pedir_info', 2, messageId);
          } catch (e) {
            console.warn('⚠️ No se pudo registrar sales_intelligence (more info):', e);
          }

          return;
        }

        // Si reply es null, NO retornamos: dejamos que el pipeline normal siga.
      }
    } catch (e) {
      console.warn("⚠️ No se pudo leer info_explicada; continúo pipeline normal:", e);
      // No return
    }
  }

  // === FAST-PATH MULTI-INTENCIÓN ===
  try {
    const top = await detectTopIntents(userInput, tenant.id, canal as Canal, 3);
    console.log('[MULTI] top=', top);

    const hasPrecio = top.some(t => t.intent === 'precio');
    const hasInfo   = top.some(t => t.intent === 'interes_clases' || t.intent === 'pedir_info');
    const multiAsk  = top.length >= 2 || (hasPrecio && hasInfo);

    console.log('[MULTI] hasPrecio=', hasPrecio, 'hasInfo=', hasInfo, 'len=', top.length, 'multiAsk=', multiAsk);

    if (multiAsk) {
      const multi = await answerMultiIntent({ tenantId: tenant.id, canal: canal as Canal, userText: userInput, idiomaDestino, promptBase });

      console.log('[MULTI] answer length=', multi?.text?.length ?? 0);

      if (multi) {
      let multiText = multi.text || '';

      const askedSchedule = /\b(schedule|schedules?|hours?|times?|timetable|horario|horarios)\b/i.test(userInput);
      const askedPrice    = PRICE_REGEX.test(userInput);

      const hasPriceInText    = /\$|S\/\.?\s?|\b\d{1,3}(?:[.,]\d{2})\b/.test(multiText); // añade S/ por si acaso
      const hasScheduleInText = /\b(\d{1,2}:\d{2}\s?(?:am|pm)?)\b/i.test(multiText);

      // ⬇️ PREPEND precios si faltan
      if (askedPrice && !hasPriceInText) {
        try {
          const precioFAQ = await fetchFaqPrecio(tenant.id, canal);
          if (precioFAQ?.trim()) {
            multiText = [precioFAQ.trim(), '', multiText.trim()].join('\n\n'); // <— PREPEND
          }
        } catch (e) {
          console.warn('⚠️ No se pudo anexar FAQ precios en MULTI:', e);
        }
      }

      // ⬇️ APPEND horario si falta
      if (askedSchedule && !hasScheduleInText) {
        try {
          const hitH = await getFaqByIntent(tenant.id, canal, 'horario');
          if (hitH?.respuesta?.trim()) {
            multiText = [multiText.trim(), '', hitH.respuesta.trim()].join('\n\n'); // <— APPEND
          }
        } catch (e) {
          console.warn('⚠️ No se pudo anexar FAQ horario en MULTI:', e);
        }
      }

      // Asegura idioma de salida por si acaso
      try {
        const langOut = await detectarIdioma(multiText);
        if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
          multiText = await traducirMensaje(multiText, idiomaDestino);
        }
      } catch {}

      // Usa el CTA según idioma (asegúrate de haber definido CTA_TXT tras calcular idiomaDestino)
      const out = tidyMultiAnswer(multiText, {
        maxLines: MAX_WHATSAPP_LINES - 2, // deja espacio al CTA
        freezeUrls: true,
        cta: CTA_TXT
      });

      
      // ⬇️ CTA por intención (multi-intent)
      const prefer = askedPrice ? 'precio' : (askedSchedule ? 'horario' : null);
      const intentForCTA = pickIntentForCTA({
        firstOfTop: top?.[0]?.intent || null,
        prefer
      });
      
      const ctaXraw = await pickCTA(tenant, intentForCTA, canal);
      const ctaX    = await translateCTAIfNeeded(ctaXraw, idiomaDestino);
      const outWithCTA = appendCTAWithCap(out, ctaX);

      // ✅ Fallback: si pidió precios y el texto final no trae montos, PREPEND una línea/resumen (sin enviar aparte)
      if (askedPrice && !(/\$|S\/\.?\s?|\b\d{1,3}(?:[.,]\d{2})\b/.test(outWithCTA))) {
        try {
          const precioFAQ = await fetchFaqPrecio(tenant.id, canal);
          if (precioFAQ?.trim()) {
            const resumen = precioFAQ
              .split('\n')
              .filter(l => /\$|S\/\.?\s?|\b\d{1,3}(?:[.,]\d{2})\b/.test(l))
              .slice(0, 3)
              .join('\n')
              .trim();

            if (resumen) {
              // lo metemos al principio del mismo mensaje
              const merged = [resumen, "", outWithCTA].join("\n\n").trim();

              // ✅ estado: dejamos claro que ya respondimos por fast-path con resumen
              transition({
                flow: "generic_sales",
                step: "answer",
                patchCtx: {
                  last_bot_action: "answered_fast_path_summary",
                  fast_path_intent: intentForCTA || top?.[0]?.intent || INTENCION_FINAL_CANONICA || null,
                },
              });

              setReply(
                merged,
                "fast-path-multi",
                intentForCTA || top?.[0]?.intent || INTENCION_FINAL_CANONICA || null
              );

              await finalizeReply();
              return;
            }
          }
        } catch {}
      }

      // ✅ anti-loop simple: si ya respondimos por fast-path hace 1 turno, evita repetir el mismo patrón
      if (convoCtx?.last_reply_source === "fast-path-multi" && convoCtx?.last_user_text === userInput) {
        transition({ step: "close" });
        return await replyAndExit(
          idiomaDestino === "en" ? "Got it. Anything else you need?" : "Perfecto. ¿Te ayudo con algo más?",
          "fast-path-repeat-guard",
          intentForCTA || top?.[0]?.intent || INTENCION_FINAL_CANONICA || null
        );
      }

      transition({
        flow: "generic_sales",
        step: "answer",
        patchCtx: {
          last_bot_action: "answered_fast_path",
          fast_path_intent: intentForCTA || top?.[0]?.intent || INTENCION_FINAL_CANONICA || null,
        },
      });

      setReply(
        outWithCTA,
        "fast-path-multi",
        intentForCTA || top?.[0]?.intent || INTENCION_FINAL_CANONICA || null
      );

      // 🔔 Registrar venta si aplica + follow-up (ANTES del finalize no importa; no depende del send)
      try {
        const det = await detectarIntencion(userInput, tenant.id, "whatsapp");
        const intFinal = normalizeIntentAlias((det?.intencion || "").toLowerCase());
        const nivel = det?.nivel_interes ?? 1;
        await recordSalesIntent(tenant.id, contactoNorm, canal, userInput, intFinal, nivel, messageId);
        await scheduleFollowUp(intFinal, nivel, userInput);
      } catch (e) {
        console.warn("⚠️ No se pudo registrar sales_intelligence en fast-path:", e);
      }

      await finalizeReply();
      return;
      }
    }
  } catch (e) {
    console.warn('⚠️ Multi-intent fast-path falló; sigo pipeline normal:', e);
  }

  // CTA por intención (usa tenant_ctas.intent_slug en TEXT, no UUID)
  async function getTenantCTA(tenantId: string, intent: string, channel: string) {
    const inten = normalizeIntentAlias((intent || '').trim().toLowerCase());

    // 1) Coincidencia exacta por canal o comodín '*'
    let q = await pool.query(
      `SELECT cta_text, cta_url
      FROM tenant_ctas
      WHERE tenant_id = $1
        AND intent_slug = $2
        AND (canal = $3 OR canal = '*')
      ORDER BY CASE WHEN canal=$3 THEN 0 ELSE 1 END
      LIMIT 1`,
      [tenantId, inten, channel]
    );
    if (q.rows[0]) return q.rows[0];

    // 2) Fallback 'global' del mismo canal (o '*')
    q = await pool.query(
      `SELECT cta_text, cta_url
      FROM tenant_ctas
      WHERE tenant_id = $1
        AND intent_slug = 'global'
        AND (canal = $2 OR canal = '*')
      ORDER BY CASE WHEN canal=$2 THEN 0 ELSE 1 END
      LIMIT 1`,
      [tenantId, channel]
    );
    return q.rows[0] || null;
  }

  // ✅ Valida URL simple
  function isValidUrl(u?: string) {
    try {
      if (!u) return false;
      if (!/^https?:\/\//i.test(u)) return false;
      new URL(u);
      return true;
    } catch {
      return false;
    }
  }

  // ✅ CTA “global” guardada en las columnas del tenant (no en tenant_ctas)
  function getGlobalCTAFromTenant(tenant: any) {
    const t = (tenant?.cta_text || '').trim();
    const u = (tenant?.cta_url  || '').trim();
    if (t && isValidUrl(u)) return { cta_text: t, cta_url: u };
    return null;
  }

  // Selecciona CTA por intención; si no hay, usa CTA global del tenant
  async function pickCTA(tenant: any, intent: string | null, channel: string) {
  if (intent) {
    const byIntent = await getTenantCTA(tenant.id, intent, channel);
    if (byIntent) return byIntent;
  }
  // fallback opcional desde columnas del tenant (si las usas)
  const t = (tenant?.cta_text || '').trim();
  const u = (tenant?.cta_url  || '').trim();
  if (t && isValidUrl(u)) return { cta_text: t, cta_url: u };
  return null;
}

  // ⏲️ Programador de follow-up (WhatsApp) — FIX: hard-gate anti "gracias/ok/saludos"
  async function scheduleFollowUp(intFinal: string, nivel: number, userTextRaw: string) {
    try {
      const raw = (userTextRaw || "").trim();

      // 0) Hard gates: nunca follow-up por cortesía o mensajes vacíos/cortos
      const isCourtesy =
        saludoPuroRegex.test(raw) ||
        graciasPuroRegex.test(raw) ||
        smallTalkRegex.test(raw) ||
        /^(ok|okay|vale|perfecto|listo|gracias|thanks|thank\s*you)\b/i.test(raw);

      const hasLetters = /\p{L}/u.test(raw);
      const tooShort = normalizarTexto(raw).length < 4;
      const numericOnly = /^\s*\d+\s*$/.test(raw);

      if (isCourtesy || !hasLetters || tooShort || numericOnly) {
        console.log("⛔ follow-up blocked (courtesy/short/numeric/no-letters)", {
          raw,
          isCourtesy,
          hasLetters,
          tooShort,
          numericOnly,
        });
        return;
      }

      // 1) Lógica original de gate por intención/nivel
      const intencionesFollowUp = ["interes_clases", "reservar", "precio", "comprar", "horario"];
      const low = (intFinal || "").toLowerCase();

      const condition = (nivel >= 3) || intencionesFollowUp.includes(low);
      console.log("⏩ followup gate (WA)", { intFinal: low, nivel, condition });

      if (!condition) return;

      // Config tenant
      const { rows: cfgRows } = await pool.query(
        `SELECT * FROM follow_up_settings WHERE tenant_id = $1`,
        [tenant.id]
      );
      const cfg = cfgRows[0];
      if (!cfg) {
        console.log("⚠️ Sin follow_up_settings; no se programa follow-up.");
        return;
      }

      // Selección del mensaje por intención
      let msg = cfg.mensaje_general || "¡Hola! ¿Te gustaría que te ayudáramos a avanzar?";
      if (low.includes("precio") && cfg.mensaje_precio) msg = cfg.mensaje_precio;
      else if ((low.includes("agendar") || low.includes("reservar")) && cfg.mensaje_agendar) msg = cfg.mensaje_agendar;
      else if ((low.includes("ubicacion") || low.includes("location")) && cfg.mensaje_ubicacion) msg = cfg.mensaje_ubicacion;

      // Asegura idioma del cliente
      try {
        const lang = await detectarIdioma(msg);
        if (lang && lang !== "zxx" && lang !== idiomaDestino) {
          msg = await traducirMensaje(msg, idiomaDestino);
        }
      } catch {}

      // Evita duplicados: borra pendientes no enviados
      await pool.query(
        `DELETE FROM mensajes_programados
        WHERE tenant_id = $1 AND canal = $2 AND contacto = $3 AND enviado = false`,
        [tenant.id, "whatsapp", contactoNorm]
      );

      const delayMin = getConfigDelayMinutes(cfg, 60);
      const fechaEnvio = new Date();
      fechaEnvio.setMinutes(fechaEnvio.getMinutes() + delayMin);

      const { rows } = await pool.query(
        `INSERT INTO mensajes_programados
        (tenant_id, canal, contacto, contenido, fecha_envio, enviado)
        VALUES ($1, $2, $3, $4, $5, false)
        RETURNING id`,
        [tenant.id, "whatsapp", contactoNorm, msg, fechaEnvio]
      );

      console.log("📅 Follow-up programado (WA)", {
        id: rows[0]?.id,
        tenantId: tenant.id,
        contacto: fromNumber,
        delayMin,
        fechaEnvio: fechaEnvio.toISOString(),
      });
    } catch (e) {
      console.warn("⚠️ No se pudo programar follow-up (WA):", e);
    }
  }

  // 💬 Small-talk tipo "hello how are you" / "hola como estas"
  if (!handled && smallTalkRegex.test(userInput.trim())) {
    transition({
      flow: "generic_sales",
      step: "need", // después del smalltalk, vuelve a descubrir necesidad
      patchCtx: {
        last_bot_action: "handled_smalltalk",
      },
    });

    return await replyAndExit(
      buildSaludoSmallTalk(tenant, idiomaDestino),
      "smalltalk",
      "saludo"
    );
  }

  // 💬 Saludo puro: "hola", "hello", "buenas", etc.
  if (!handled && saludoPuroRegex.test(userInput.trim())) {
    transition({
      flow: "generic_sales",
      step: "need",
      patchCtx: {
        last_bot_action: "handled_greeting",
      },
    });

    return await replyAndExit(
      buildSaludoConversacional(tenant, idiomaDestino),
      "saludo",
      "saludo"
    );
  }

  // 🙏 Mensaje de solo "gracias / thank you / thanks"
  if (!handled && graciasPuroRegex.test(userInput.trim())) {
    transition({
      flow: "generic_sales",
      step: "close", // gracias es cierre, no discovery
      patchCtx: {
        last_bot_action: "handled_thanks",
      },
    });

    return await replyAndExit(
      buildGraciasRespuesta(idiomaDestino),
      "gracias",
      "agradecimiento"
    );
  }

  // 🔎 Intención antes del EARLY RETURN
  const det0 = await detectarIntencion(userInput, tenant.id, 'whatsapp');
  const intenCanon = normalizeIntentAlias((det0?.intencion || '').toLowerCase());
  const nivelCanon = det0?.nivel_interes ?? 1;

  // 👉 si es directa, NO hagas early return; deja que pase al pipeline de FAQ
  const esDirecta = INTENTS_DIRECT.has(intenCanon);

  if (!esDirecta) {
    console.log('🛣️ Ruta: EARLY_RETURN con promptBase (no directa). Intención =', intenCanon);

    try {
      const fallbackBienvenida = getBienvenidaPorCanal('whatsapp', tenant, idiomaDestino);

      const { text } = await answerWithPromptBase({
        tenantId: tenant.id,
        promptBase: promptBaseMem,
        userInput,
        idiomaDestino,
        canal: 'whatsapp',
        maxLines: MAX_WHATSAPP_LINES,
        fallbackText: fallbackBienvenida,
      });

      let out = text;

      // ⬇️ CTA por intención (early return)
      const intentForCTA = pickIntentForCTA({
        fallback: intenCanon, // ya calculaste intenCanon antes
      });

      const ctaXraw = await pickCTA(tenant, intentForCTA, canal);
      const ctaX    = await translateCTAIfNeeded(ctaXraw, idiomaDestino);
      const outWithCTA = isSmallTalkOrCourtesy
        ? out                         // ❌ NO CTA si es saludo / gracias / ok
        : appendCTAWithCap(out, ctaX); // ✅ CTA normal en el resto de casos

      // ========================================
      // ✅ Guardar estado YES/NO si el mensaje termina en pregunta
      // ========================================
      const endsAsQuestion = /\?\s*$/.test((outWithCTA || "").trim());
      const looksLikeYesNo =
        /(te\s+gustar[ií]a|quieres|deseas|would\s+you\s+like|do\s+you\s+want)/i.test(outWithCTA || "");

      if (endsAsQuestion && looksLikeYesNo) {
        // ✅ Entramos a un mini-flow de confirmación (sí/no) para el próximo turno
        transition({
          flow: "yesno",
          step: "awaiting_confirmation",
          patchCtx: {
            kind: "followup",
            intent: intenCanon || null,
            last_bot_action: "asked_yesno",
          },
        });
      } else {
        // ✅ No necesitamos yes/no; volvemos al flow genérico (sin borrar fila)
        transition({
          flow: "generic_sales",
          step: "answer",
          patchCtx: {
            kind: null,
            intent: intenCanon || null,
            last_bot_action: "answered_early_return",
          },
        });

        // (Opcional) si quieres “limpiar” algunas llaves del contexto para no arrastrarlas:
        // convoCtx = { ...convoCtx, kind: null, intent: intenCanon || null };
      }

      setReply(outWithCTA, "early-return", intenCanon || null);

      // (Opcional) métricas / follow-up + registrar venta si aplica
      try {
        const det = await detectarIntencion(userInput, tenant.id, "whatsapp");
        const nivel = det?.nivel_interes ?? 1;
        const intFinal = normalizeIntentAlias((det?.intencion || "").toLowerCase());
        await recordSalesIntent(tenant.id, contactoNorm, canal, userInput, intFinal, nivel, messageId);

        if (nivel >= 3 || ["interes_clases","reservar","precio","comprar","horario"].includes(intFinal)) {
          await scheduleFollowUp(intFinal, nivel, userInput);
        }
      } catch (e) {
        console.warn("⚠️ No se pudo registrar sales_intelligence en EARLY_RETURN (WA):", e);
      }

      await finalizeReply();
      return;

    } catch (e) {
      console.warn('❌ EARLY_RETURN helper falló; sigo con pipeline FAQ/intents:', e);
      // ⛔️ Sin return aquí: continúa al pipeline de FAQ / intents
    }
  } else {
    console.log('🛣️ Ruta: FAQ/Intents (intención directa). Intención =', intenCanon);
  }

  // 3️⃣ Detectar intención
  const { intencion: intencionDetectada } = await detectarIntencion(mensajeUsuario, tenant.id, 'whatsapp');
  const intencionLower = intencionDetectada?.trim().toLowerCase() || "";
  console.log(`🧠 Intención detectada al inicio para tenant ${tenant.id}: "${intencionLower}"`);

  let intencionProc = intencionLower; // se actualizará tras traducir (si aplica)
  let intencionParaFaq = intencionLower; // esta será la que usemos para consultar FAQ

    // Paso 1: Detectar idioma y traducir para evaluar intención
    const textoTraducido = idiomaDestino !== 'es'
      ? await traducirMensaje(userInput, 'es')
      : userInput;

    // ✅ NUEVO: quitar saludos al inicio para no sesgar la intención
    const textoParaIntent = stripLeadGreetings(textoTraducido);

    const { intencion: intencionProcesada } =
      await detectarIntencion(textoParaIntent, tenant.id, 'whatsapp');

    intencionProc = (intencionProcesada || '').trim().toLowerCase();
    intencionParaFaq = intencionProc;
    console.log(`🧠 Intención detectada (procesada): "${intencionProc}"`);

    // Refina dudas a sub-slug
    if (intencionProc === 'duda') {
      const refined = buildDudaSlug(userInput);
      console.log(`🎯 Refino duda → ${refined}`);
      intencionProc = refined;
      intencionParaFaq = refined;
    }

    // Canonicaliza
    intencionProc = normalizeIntentAlias(intencionProc);
    intencionParaFaq = normalizeIntentAlias(intencionParaFaq);

    INTENCION_FINAL_CANONICA = (intencionParaFaq || intencionProc || '').trim().toLowerCase();
    console.log(`🎯 Intención final (canónica) = ${INTENCION_FINAL_CANONICA}`);

    // 👉 Detección de temporalidad/especificidad (sin DB) + fallbacks
    const cleanedForTime = stripLeadGreetings(userInput);

    // 1) Intenta con extractor “lite”
    const entsEarly = extractEntitiesLite(cleanedForTime);

    try {
    } catch (e) {
      console.warn('⚠️ Rama específica falló; continuará pipeline normal:', e);
    }

    // 💡 Heurística específica: si el usuario pide precios + horarios, compón una respuesta combinada.
    const WANTS_SCHEDULE = /\b(schedule|schedules?|hours?|times?|timetable|horario|horarios)\b/i.test(userInput);
    const WANTS_PRICE = PRICE_REGEX.test(userInput);

    if (WANTS_PRICE && WANTS_SCHEDULE) {
      try {
        // Trae ambas FAQs
        const [faqPrecio, faqHorario] = await Promise.all([
          fetchFaqPrecio(tenant.id, canal),
          (async () => {
            const hitH = await getFaqByIntent(tenant.id, canal, 'horario');
            return hitH?.respuesta || null;
          })()
        ]);

        // Si no hay alguna de las dos, sigue el pipeline normal
        if (!faqPrecio || !faqHorario) {
          console.log('ℹ️ Combo precio+horario: falta alguna FAQ; sigo pipeline normal.');
        } else {
          // Construye "hechos" combinados y pásalos por tu promptBase para formato/tono/idioma
          const facts = [
            'INFO_PRECIOS:\n' + faqPrecio,
            '',
            'INFO_HORARIO:\n' + faqHorario
          ].join('\n');

          const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
          const systemPrompt = [
            promptBaseMem,
            '',
            `Responde SIEMPRE en ${idiomaDestino === 'en' ? 'English' : 'Español'}.`,
            `Formato WhatsApp: máx. ${MAX_WHATSAPP_LINES} líneas en prosa (sin bullets).`,
            'Usa solo los HECHOS provistos. Si hay enlaces oficiales, comparte solo 1 (el más pertinente).',
            'Incluye precios y horarios en un mismo mensaje, cerrando con un CTA breve.'
          ].join('\n');

          const userPrompt = [
            `MENSAJE_USUARIO:\n${userInput}`,
            '',
            `HECHOS AUTORIZADOS (usa ambos):\n${facts}`
          ].join('\n');

          let out = '';
          try {
            const history = await getRecentHistoryForModel({
              tenantId: tenant.id,
              canal,
              fromNumber: contactoNorm,
              excludeMessageId: messageId,
              limit: 18,
            });

            const completion = await openai.chat.completions.create({
              model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
              temperature: 0.2,
              max_tokens: 400,
              messages: [
              // Prompt base del negocio (NO se toca)
              { role: "system" as const, content: systemPrompt },

              // 👇 DECISIÓN DEL BACKEND (backend decide, NO habla)
              ...(nextAction?.type === "yesno_resolved"
                ? [
                    {
                      role: "system" as const,
                      content: `CONVERSATION_DECISION:
            type: yesno_resolved
            decision: ${nextAction.decision}
            kind: ${nextAction.kind ?? "null"}
            intent: ${nextAction.intent ?? "null"}

            RULES:
            - Do NOT explain infrastructure
            - Do NOT explain how it works
            - Respond only as the business
            - Keep the message short`,
                    },
                  ]
                : []),

              // Historial real
              ...history,

              // Mensaje del usuario
              { role: "user" as const, content: userPrompt },
            ],
            });
            out = (completion.choices[0]?.message?.content || '').trim();
            // Asegura idioma por si acaso
            try {
              const langOut = await detectarIdioma(out);
              if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
                out = await traducirMensaje(out, idiomaDestino);
              }
            } catch {}
          } catch (e) {
            console.warn('⚠️ LLM combo precio+horario falló; uso facts crudos:', e);
            out = `${faqHorario}\n\n${faqPrecio}`;
          }

          out = `${out}\n\n${CTA_TXT}`;

          transition({
            flow: "generic_sales",
            step: "answer",
            patchCtx: {
              last_bot_action: "answered_price_hours",
              last_intent_hint: "precio",
            },
          });

          // registra intención/seguimiento con "precio" como señal de venta
          try {
            const det = await detectarIntencion(userInput, tenant.id, "whatsapp");
            const intFinal = normalizeIntentAlias(det?.intencion || "precio");
            const nivel = det?.nivel_interes ?? 1;

            await recordSalesIntent(
              tenant.id,
              contactoNorm,
              canal,
              userInput,
              intFinal,
              nivel,
              messageId
            );

            await scheduleFollowUp(intFinal, nivel, userInput);
          } catch (e) {
            console.warn("⚠️ No se pudo registrar sales_intelligence en combo-precio-horario:", e);
          }

          return await replyAndExit(out, "combo-precio-horario", "precio");
        }
      } catch (e) {
        console.warn('⚠️ Heurística precio+horario falló; sigo pipeline normal:', e);
      }
    }

    // ─── INTENT MATCHER — RESPONDE ANTES DE FAQs/IA ───────────────────────
    try {
      // Comparamos en ES (igual que FAQs). Si el cliente no habla ES, traducimos su mensaje a ES.
      const textoParaMatch = (idiomaDestino !== 'es')
        ? await traducirMensaje(userInput, 'es').catch(() => userInput)
        : userInput;

      console.log('[INTENTS] match input=', textoParaMatch);

      const respIntent = await buscarRespuestaPorIntencion({
        tenant_id: tenant.id,
        canal: 'whatsapp',
        mensajeUsuario: textoParaMatch,
        idiomaDetectado: idiomaDestino,
        umbral: Math.max(INTENT_THRESHOLD, 0.70),
        filtrarPorIdioma: true
      });

      console.log('[INTENTS] result=', respIntent);

      // --- Anti-mismatch entre canónica y matcher ---
      const canonical = (INTENCION_FINAL_CANONICA || '').toLowerCase();
      const respIntentName = (respIntent?.intent || '').toLowerCase();

      const isCanonicalDirect = isDirectIntent(canonical, INTENTS_DIRECT);
      const askedPrice = PRICE_REGEX.test(userInput);

      // 1) Nunca aceptes 'precio' si NO lo pidió y la canónica es distinta
      if (respIntent && respIntentName === 'precio' && !askedPrice && canonical && canonical !== 'precio') {
        console.log('[GUARD-2] bloqueo precio: no fue solicitado y la canónica=', canonical, 'score=', respIntent?.score);
        // @ts-ignore
        respIntent.intent = null;
        // @ts-ignore
        respIntent.respuesta = null;
      }

      // 2) Si la canónica es DIRECTA y difiere del matcher, exige score alto (>= 0.85)
      if (respIntent && isCanonicalDirect && respIntentName && respIntentName !== canonical) {
        const score = Number(respIntent?.score ?? 0);
        if (score < MATCHER_MIN_OVERRIDE) {
          console.log('[GUARD-2] canónica directa vs matcher (score bajo). Mantengo canónica:', { canonical, respIntentName, score });
          // @ts-ignore
          respIntent.intent = null;
          // @ts-ignore
          respIntent.respuesta = null;
        }
      }

      if (respIntent?.respuesta) {
        let facts = respIntent.respuesta;

        // (Opcional) añade un breve resumen si el user pidió “info + precios”
        const askedInfo = /\b(info(?:rmación)?|information|clases?|servicios?)\b/i.test(userInput);
        const askedPrice2 = PRICE_REGEX.test(userInput);
        const askedSchedule = /\b(schedule|schedules?|hours?|times?|timetable|horario|horarios)\b/i.test(userInput);

        if ((askedInfo && askedPrice2) || (askedInfo && askedSchedule) || (askedPrice2 && askedSchedule)) {
          try {
            // agrega una FAQ adicional a los facts según falte precio u horario
            const needPrice = !/precio/i.test(respIntent?.intent || '') && askedPrice2;
            const needHorario = (respIntent?.intent || '') !== 'horario' && askedSchedule;

            if (needPrice) {
              const precio = await fetchFaqPrecio(tenant.id, canal);
              if (precio) facts = `${facts}\n\n${precio}`;
            }
            if (needHorario) {
              const hitHorario = await getFaqByIntent(tenant.id, canal, 'horario');
              if (hitHorario?.respuesta) facts = `${facts}\n\n${hitHorario.respuesta}`;
            }
          } catch {}
        }

        // 🔸 Siempre pasa por LLM con tu promptBase
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
        const systemPrompt = [
          promptBaseMem,
          '',
          `Responde SIEMPRE en ${idiomaDestino === 'en' ? 'English' : 'Español'}.`,
          `Formato WhatsApp: máx. ${MAX_WHATSAPP_LINES} líneas en PROSA. **Sin Markdown, sin viñetas, sin encabezados/###**.`,
          'Usa únicamente los HECHOS; no inventes.',
          'Si hay ENLACES_OFICIALES en los hechos, comparte solo 1 (el más pertinente) tal cual.'
        ].join('\n');

        const userPrompt = [
          `MENSAJE_USUARIO:\n${userInput}`,
          '',
          `HECHOS (usa sólo esto como fuente):\n${facts}`,
          '',
          `IDIOMA_SALIDA: ${idiomaDestino}`
        ].join('\n');

        let out = facts;
        try {
          const history = await getRecentHistoryForModel({
            tenantId: tenant.id,
            canal,
            fromNumber: contactoNorm,
            excludeMessageId: messageId,
            limit: 18,
          });

          const completion = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
            temperature: 0.2,
            max_tokens: 400,
            messages: [
            // Prompt base del negocio (NO habla el backend)
            { role: "system" as const, content: systemPrompt },

            // ⬇️ DECISIÓN TÉCNICA DEL BACKEND (sin copy, sin explicación)
            ...(nextAction?.type === "yesno_resolved"
              ? [
                  {
                    role: "system" as const,
                    content: `CONVERSATION_DECISION:
          type: yesno_resolved
          decision: ${nextAction.decision}
          kind: ${nextAction.kind ?? "null"}
          intent: ${nextAction.intent ?? "null"}

          RULES:
          - Do NOT explain how it works
          - Do NOT explain infrastructure
          - Respond only as the business
          - Keep the response short`,
                  },
                ]
              : []),

            // Historial real
            ...history,

            // Mensaje del usuario
            { role: "user" as const, content: userPrompt },
          ],
          });
          // registrar tokens
          const used = completion.usage?.total_tokens || 0;
          if (used > 0) {
            await pool.query(
              `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
              VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE), $2)
              ON CONFLICT (tenant_id, canal, mes)
              DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
              [tenant.id, used]
            );
          }
          out = completion.choices[0]?.message?.content?.trim() || out;
        } catch (e) {
          console.warn('LLM compose falló; uso facts crudos:', e);
        }

        // Asegura idioma
        try {
          const langOut = await detectarIdioma(out);
          if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
            out = await traducirMensaje(out, idiomaDestino);
          }
        } catch {}

        // ⬇️ CTA por intención (matcher)
        const intentForCTA = pickIntentForCTA({
          matcher: respIntent?.intent || null,
          canonical: INTENCION_FINAL_CANONICA || null
        });
        const ctaXraw = await pickCTA(tenant, intentForCTA, canal);
        const ctaX    = await translateCTAIfNeeded(ctaXraw, idiomaDestino);
        const outWithCTA = appendCTAWithCap(out, ctaX);

        transition({
          flow: "generic_sales",
          step: "answer",
          patchCtx: {
            last_bot_action: "answered_intent",
            matched_intent: respIntent?.intent || INTENCION_FINAL_CANONICA || null,
          },
        });

        setReply(
          outWithCTA,
          "intent-matcher",
          respIntent?.intent || INTENCION_FINAL_CANONICA || null
        );

        // 🔔 Registrar venta si aplica + follow-up
        try {
          let intFinal = (respIntent?.intent || "").toLowerCase().trim();
          if (intFinal === "duda") intFinal = buildDudaSlug(userInput);
          intFinal = normalizeIntentAlias(intFinal);

          const det = await detectarIntencion(userInput, tenant.id, "whatsapp");
          const nivel = det?.nivel_interes ?? 1;

          await recordSalesIntent(tenant.id, contactoNorm, canal, userInput, intFinal, nivel, messageId);
          await scheduleFollowUp(intFinal, nivel, userInput);

          // (Opcional) deja evidencia en convoCtx para debugging y anti-loop
          transition({
            patchCtx: {
              last_sales_intent: intFinal,
              last_sales_level: nivel,
            },
          });
        } catch (e) {
          console.warn("⚠️ No se pudo programar follow-up post-intent (WA):", e);
        }

        await finalizeReply();
        return;
      }

    } catch (e) {
      console.warn('⚠️ Matcher de intenciones no coincidió o falló:', e);
    }

  // [REPLACE] lookup robusto
  let respuestaDesdeFaq: string | null = null;

  console.log('[FAQ-LOOKUP] tenant=', tenant.id, 'canal=', canal, 'intent=', intencionParaFaq);

  const hit = await getFaqByIntent(tenant.id, canal, intencionParaFaq);
  if (hit) {
    const r = String(hit.respuesta ?? '').trim();

    console.log(
      '📚 FAQ encontrada →',
      hit.id,
      hit.intencion,
      'canal:',
      hit.canal,
      'len=',
      r.length
    );

    // ✅ si está vacía (len=0) NO la tratamos como respuesta válida
    respuestaDesdeFaq = r.length > 0 ? r : null;
  } else {
    console.log('🚫 FAQ NO encontrada para intent:', intencionParaFaq);
  }

  if (isDirectIntent(intencionParaFaq, INTENTS_DIRECT)) {
    if (intencionParaFaq === 'precio') {
      respuestaDesdeFaq = await fetchFaqPrecio(tenant.id, canal);
    } else {
      const hit2 = await getFaqByIntent(tenant.id, canal, intencionParaFaq);
      if (hit2) {
        const r2 = String(hit2.respuesta ?? '').trim();

        console.log(
          '📚 FAQ encontrada para intención:',
          hit2.intencion,
          'canal:',
          hit2.canal,
          'len=',
          r2.length
        );

        respuestaDesdeFaq = r2.length > 0 ? r2 : null;
      }
    }
  }

  if (respuestaDesdeFaq) {
    // 1) Construye los HECHOS desde la FAQ oficial
    let facts = respuestaDesdeFaq;

    // 2) Pásalo por OpenAI con tu promptBase (igual que en la rama de intents)
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

    const systemPrompt = [
      promptBaseMem,
      '',
      `Responde SIEMPRE en ${idiomaDestino === 'en' ? 'English' : 'Español'}.`,
      `Formato WhatsApp: máx. ${MAX_WHATSAPP_LINES} líneas, claro y con bullets si hace falta.`,
      'Usa SOLO la información del prompt.',
      'SI HAY PRECIOS EN EL PROMPT/HECHOS, MENCIONA al menos 1-3 planes con su monto (resumen corto).',
      'Si hay ENLACES_OFICIALES en los prompt/hechos, comparte solo 1 (el más pertinente) tal cual.',
      'Si el usuario preguntó varias cosas, cúbrelas en UN solo mensaje.'
    ].join('\n');

    const userPrompt = [
      `MENSAJE_USUARIO:\n${userInput}`,
      '',
      `HECHOS (fuente autorizada):\n${facts}`
    ].join('\n');

    let out = facts; // fallback si el LLM falla
    let tokens = 0;
    try {
      const history = await getRecentHistoryForModel({
        tenantId: tenant.id,
        canal,
        fromNumber: contactoNorm,
        excludeMessageId: messageId,
        limit: 18,
      });

      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0.2,
        max_tokens: 400,
        messages: [
        // Prompt del negocio (NO habla backend)
        { role: "system" as const, content: systemPrompt },

        // 🔒 DECISIÓN DEL BACKEND (solo si existe)
        ...(nextAction?.type === "yesno_resolved"
          ? [{
              role: "system" as const,
              content: `CONVERSATION_DECISION
      type: yesno_resolved
      decision: ${nextAction.decision}
      kind: ${nextAction.kind ?? "null"}
      intent: ${nextAction.intent ?? "null"}

      RULES:
      - Do NOT explain how it works
      - Do NOT mention systems or automation
      - Respond only as the business
      - Keep it short`
            }]
          : []),

        // Historial real
        ...history,

        // Mensaje del usuario
        { role: "user" as const, content: userPrompt },
      ],
      });
      // registrar tokens
      const used = completion.usage?.total_tokens || 0;
      if (used > 0) {
        await pool.query(
          `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
          VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE), $2)
          ON CONFLICT (tenant_id, canal, mes)
          DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
          [tenant.id, used]
        );
      }
      out = completion.choices[0]?.message?.content?.trim() || out;
      tokens = completion.usage?.total_tokens || 0;
    } catch (e) {
      console.warn('LLM compose (FAQ) falló; envío facts crudos:', e);
    }

    // 3) Asegura idioma de salida
    try {
      const langOut = await detectarIdioma(out);
      if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
        out = await traducirMensaje(out, idiomaDestino);
      }
    } catch {}

    // ⬇️ CTA por intención (FAQ directa)
    const intentForCTA = pickIntentForCTA({
      canonical: INTENCION_FINAL_CANONICA || null,
      fallback: intencionParaFaq || null
    });
    const ctaXraw = await pickCTA(tenant, intentForCTA, canal);
    const ctaX    = await translateCTAIfNeeded(ctaXraw, idiomaDestino);
    const outWithCTA = appendCTAWithCap(out, ctaX);

    transition({
      flow: "generic_sales",
      step: "answer",
      patchCtx: {
        last_bot_action: "answered_faq_direct",
        last_faq_intent: INTENCION_FINAL_CANONICA || intencionParaFaq || null,
      },
    });

    setReply(outWithCTA, "faq-direct", INTENCION_FINAL_CANONICA || intencionParaFaq || null);

    // 🔔 Registrar venta si aplica + follow-up
    try {
      const det = await detectarIntencion(userInput, tenant.id, "whatsapp");
      const nivelFaq = det?.nivel_interes ?? 1;

      const intFinal = ((INTENCION_FINAL_CANONICA || intencionParaFaq || "") + "").toLowerCase().trim();

      await recordSalesIntent(tenant.id, contactoNorm, canal, userInput, intFinal, nivelFaq, messageId);

      const intencionesFollowUp = ["interes_clases", "reservar", "precio", "comprar", "horario"];
      if (nivelFaq >= 3 || intencionesFollowUp.includes(intFinal)) {
        await scheduleFollowUp(intFinal, nivelFaq, userInput);
      }

      // (Opcional) evidencia en contexto
      transition({
        patchCtx: {
          last_sales_intent: intFinal,
          last_sales_level: nivelFaq,
        },
      });
    } catch (e) {
      console.warn("⚠️ No se pudo programar follow-up tras FAQ (WA):", e);
    }

    await finalizeReply();
    return;
  }

  // Si NO hubo FAQ directa → similaridad
  {
    const mensajeTraducido = (idiomaDestino !== 'es')
      ? await traducirMensaje(mensajeUsuario, 'es')
      : mensajeUsuario;

    respuesta = (await buscarRespuestaSimilitudFaqsTraducido(
      faqs,
      mensajeTraducido,
      idiomaDestino
    )) || "";
  }

  // 🔒 Protección adicional: si ya respondió con FAQ oficial, no continuar
  // (por seguridad; normalmente ya retornamos antes)
  // if (respuestaDesdeFaq) return;

  // ⛔ No generes sugeridas si el mensaje NO tiene letras o es muy corto
  const hasLetters = /\p{L}/u.test(userInput);
  if (!hasLetters || normalizarTexto(userInput).length < 4) {
    console.log('🧯 No se genera sugerida (sin letras o texto muy corto).');
    // aun así responde si hay "respuesta" calculada
    if (respuesta) {
      let intentForCTA: string | null = null;
      try {
        const detEnd = await detectarIntencion(userInput, tenant.id, 'whatsapp');
        intentForCTA = pickIntentForCTA({
          canonical: INTENCION_FINAL_CANONICA || null,
          fallback: normalizeIntentAlias((detEnd?.intencion || '').toLowerCase())
        });
      } catch {}

      const cta5raw = intentForCTA ? await getTenantCTA(tenant.id, intentForCTA, canal) : null;
      const cta5    = await translateCTAIfNeeded(cta5raw, idiomaDestino);

      const withDefaultCta = cta5 ? respuesta : `${respuesta}\n\n${CTA_TXT}`;
      const respuestaWithCTA = appendCTAWithCap(withDefaultCta, cta5);

      transition({
        flow: "generic_sales",
        step: "answer",
        patchCtx: {
          last_bot_action: "answered_short_input",
          last_intent: INTENCION_FINAL_CANONICA || null,
          short_input: true,
        },
      });

      setReply(respuestaWithCTA, "short-or-nonletters", INTENCION_FINAL_CANONICA || null);
      await finalizeReply();
    }
    // registra venta si aplica
    try {
      const det = await detectarIntencion(userInput, tenant.id, 'whatsapp');
      const intFinal = normalizeIntentAlias(det?.intencion || '');
      await recordSalesIntent(tenant.id, contactoNorm, canal, userInput, intFinal, det?.nivel_interes ?? 1, messageId);
    } catch {}
    return;
  }

  if (handled) {
    transition({
      flow: activeFlow || "generic_sales",
      step: activeStep || "answer",
      patchCtx: {
        last_bot_action: convoCtx?.last_bot_action || "handled_generic",
      },
    });

    await finalizeReply();
    return;
  }

  // 🧠 Si no hay respuesta aún, generar con OpenAI y registrar como FAQ sugerida
  if (!respuestaDesdeFaq && !respuesta) {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

    const history = await getRecentHistoryForModel({
      tenantId: tenant.id,
      canal,
      fromNumber: contactoNorm,
      excludeMessageId: messageId,
      limit: 18,
    });

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 400,
      messages: [
      // Prompt del negocio (no se toca)
      { role: 'system', content: promptBaseMem },

      // ⬇️ DECISIÓN DEL BACKEND (NO TEXTO DE NEGOCIO)
      ...(nextAction
        ? [{
            role: "system" as const,
            content: `CONVERSATION_DECISION:
    type: ${nextAction.type}
    decision: ${nextAction.decision ?? 'null'}
    kind: ${nextAction.kind ?? 'null'}
    intent: ${nextAction.intent ?? 'null'}

    RULES:
    - Do NOT explain how the system works.
    - Do NOT describe infrastructure.
    - Respond naturally as the business.
    - Keep the answer short.`
          }]
        : []),

      // Historial reciente
      ...history,

      // Mensaje real del usuario (sin copy agregado)
      { role: 'user', content: userInput },
    ],
    });

    // registrar tokens
    const used = completion.usage?.total_tokens || 0;
    if (used > 0) {
      await pool.query(
        `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
        VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE), $2)
        ON CONFLICT (tenant_id, canal, mes)
        DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
        [tenant.id, used]
      );
    }
    respuesta = completion.choices[0]?.message?.content?.trim()
            || getBienvenidaPorCanal('whatsapp', tenant, idiomaDestino);

    const respuestaGenerada = respuesta;

    // 🌐 Asegurar idioma del cliente
    try {
      const idiomaRespuesta = await detectarIdioma(respuesta);
      if (idiomaRespuesta && idiomaRespuesta !== 'zxx' &&
          idiomaRespuesta !== idiomaDestino) {
        respuesta = await traducirMensaje(respuesta, idiomaDestino);
      }

    } catch (e) {
      console.warn('No se pudo traducir la respuesta de OpenAI:', e);
    }

    const respuestaGeneradaLimpia = respuesta;
    const preguntaNormalizada = normalizarTexto(userInput);
    const respuestaNormalizada = respuestaGeneradaLimpia.trim();

    let sugeridasExistentes: any[] = [];
    try {
      const sugeridasRes = await pool.query(
        'SELECT id, pregunta, respuesta_sugerida FROM faq_sugeridas WHERE tenant_id = $1 AND canal = $2',
        [tenant.id, canal]
      );
      sugeridasExistentes = sugeridasRes.rows || [];
    } catch (error) {
      console.error('⚠️ Error consultando FAQ sugeridas:', error);
    }

    // Verificación de duplicados
    const yaExisteSugerida = yaExisteComoFaqSugerida(
      userInput,
      respuestaGenerada,
      sugeridasExistentes
    );

    const yaExisteAprobada = yaExisteComoFaqAprobada(
      userInput,
      respuestaGenerada,
      faqs
    );

    if (yaExisteSugerida || yaExisteAprobada) {
      if (yaExisteSugerida) {
        await pool.query(
          `UPDATE faq_sugeridas 
           SET veces_repetida = veces_repetida + 1, ultima_fecha = NOW()
           WHERE id = $1`,
          [yaExisteSugerida.id]
        );
        console.log(`⚠️ Pregunta similar ya sugerida (ID: ${yaExisteSugerida.id})`);
      } else {
        console.log(`⚠️ Pregunta ya registrada como FAQ oficial.`);
      }
    } else {
      // 🧠 Detectar intención para evitar duplicados semánticos
      const textoTraducidoParaGuardar = idioma !== 'es'
      ? await traducirMensaje(userInput, 'es')
      : userInput;

      // Normaliza "duda" a sub-slug antes de guardar la sugerida
      const { intencion: intencionDetectadaParaGuardar } =
      await detectarIntencion(textoTraducidoParaGuardar, tenant.id, 'whatsapp');

      let intencionFinal = intencionDetectadaParaGuardar.trim().toLowerCase();
      if (intencionFinal === 'duda') {
        intencionFinal = buildDudaSlug(userInput);
      }
      intencionFinal = normalizeIntentAlias(intencionFinal);

      const { rows: sugeridasConIntencion } = await pool.query(
      `SELECT intencion FROM faq_sugeridas 
      WHERE tenant_id = $1 AND canal = $2 AND procesada = false`,
      [tenant.id, canal]
      );

      const { rows: faqsOficiales } = await pool.query(
      `SELECT intencion FROM faqs 
      WHERE tenant_id = $1 AND canal = $2`,
      [tenant.id, canal]
      );

      // Compara intención detectada con las oficiales (aplica unicidad solo a INTENT_UNIQUE)
      const enforzaUnicidad = INTENT_UNIQUE.has(intencionFinal);

      const yaExisteIntencionOficial = faqsOficiales.some(faq =>
        (faq.intencion || '').trim().toLowerCase() === intencionFinal
      );

      if (enforzaUnicidad && yaExisteIntencionOficial) {
        console.log(`⚠️ Ya existe una FAQ oficial con la intención "${intencionFinal}" para este canal y tenant. No se guardará.`);
      } else {
        const yaExisteIntencion = sugeridasConIntencion.some(faq =>
          (faq.intencion || '').trim().toLowerCase() === intencionFinal
        );

        if (enforzaUnicidad && yaExisteIntencion) {
          console.log(`⚠️ Ya existe una FAQ sugerida con la intención "${intencionFinal}" para este canal y tenant. No se guardará.`);
          // 🚫 No hacer return aquí
        } else {
          // ✅ Insertar la sugerencia
          await pool.query(
            `INSERT INTO faq_sugeridas (tenant_id, canal, pregunta, respuesta_sugerida, idioma, procesada, ultima_fecha, intencion)
            VALUES ($1, $2, $3, $4, $5, false, NOW(), $6)`,
            [tenant.id, canal, preguntaNormalizada, respuestaNormalizada, idioma, intencionFinal]
          );
          console.log(`📝 Pregunta no resuelta registrada: "${preguntaNormalizada}"`);
        }
      }
    }
  }  

  // ⬇️ CTA por intención (fallback final/generativa)
  let intentForCTA: string | null = null;
  try {
    const detEnd = await detectarIntencion(userInput, tenant.id, 'whatsapp');
    intentForCTA = pickIntentForCTA({
      canonical: INTENCION_FINAL_CANONICA || null,
      fallback: normalizeIntentAlias((detEnd?.intencion || '').toLowerCase())
    });
  } catch {}

  const intentForCTANorm = intentForCTA ? normalizeIntentAlias(intentForCTA) : null;
  const cta5raw = await pickCTA(tenant, intentForCTANorm, canal);
  const cta5    = await translateCTAIfNeeded(cta5raw, idiomaDestino);

  // Si por alguna razón nadie llenó "respuesta", usa la bienvenida del tenant
  if (!respuesta) {
    respuesta = getBienvenidaPorCanal('whatsapp', tenant, idiomaDestino);
  }

  let respuestaFinal: string;

  if (isSmallTalkOrCourtesy) {
    // 🙅‍♂️ Cortesía: sin CTA, sin empujar flujo
    respuestaFinal = respuesta;
  } else {
    // ✅ CTA solo si existe configuración (nunca texto fijo backend)
    respuestaFinal = cta5
      ? appendCTAWithCap(respuesta, cta5)
      : respuesta;
  }

  // 🧠 Anti-loop: si ya caíste en fallback-final con el mismo input,
  // NO hables otra vez. Solo cierra el turno.
  if (
    convoCtx?.last_reply_source === "fallback-final" &&
    convoCtx?.last_user_text === userInput
  ) {
    transition({
      flow: "generic_sales",
      step: "close",
      patchCtx: {
        last_bot_action: "fallback_repeat_guard",
      },
    });

    // ❗ Backend NO habla
    // ❗ No setReply
    await finalizeReply();
    return;
  }

  // 🧠 Decisión de estado (el backend decide, no redacta)
  transition({
    flow: "generic_sales",
    step: isSmallTalkOrCourtesy ? "close" : "answer",
    patchCtx: {
      last_bot_action: isSmallTalkOrCourtesy
        ? "smalltalk"
        : "fallback_answered",
    },
  });

  // 📤 Enviar SOLO lo que ya fue generado arriba
  if (!handled) {
    setReply(
      respuestaFinal,
      "fallback-final",
      INTENCION_FINAL_CANONICA || intenCanon || null
    );
  }

  await finalizeReply();
  return;

    }