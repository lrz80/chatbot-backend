// src/routes/facebook/webhook.ts

import express from "express";
import pool from "../../lib/db";
import { detectarIdioma } from "../../lib/detectarIdioma";
import { getPromptPorCanal, getBienvenidaPorCanal } from "../../lib/getPromptPorCanal";
import type { Canal } from "../../lib/detectarIntencion";
import { detectarIntencion, esIntencionDeVenta } from "../../lib/detectarIntencion";

import { requireChannel } from "../../middleware/requireChannel";
import { canUseChannel } from "../../lib/features";
import { antiPhishingGuard } from "../../lib/security/antiPhishing";
import { incrementarUsoPorCanal } from "../../lib/incrementUsage";
import { enviarMensajePorPartes } from "../../lib/enviarMensajePorPartes";
import { getIO } from "../../lib/socket";

import { saludoPuroRegex } from "../../lib/saludosConversacionales";
import { answerWithPromptBase } from "../../lib/answers/answerWithPromptBase";

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
import { clearAwaitingState } from "../../lib/awaiting";
import { createStateMachine } from "../../lib/conversation/stateMachine";
import { paymentHumanGate } from "../../lib/guards/paymentHumanGuard";
import { yesNoStateGate } from "../../lib/guards/yesNoStateGate";
import { awaitingGate } from "../../lib/guards/awaitingGate";
import { recordSalesIntent } from "../../lib/sales/recordSalesIntent";
import { detectarEmocion } from "../../lib/detectarEmocion";
import { applyEmotionTriggers } from "../../lib/guards/emotionTriggers";
import { scheduleFollowUpIfEligible, cancelPendingFollowUps } from "../../lib/followups/followUpScheduler";
import crypto from "crypto";
import { sendCapiEvent } from "../../services/metaCapi";
import { bookingFlowMvp } from "../../lib/appointments/bookingFlow";
import { isAmbiguousLangText } from "../../lib/appointments/booking/text";


type CanalEnvio = "facebook" | "instagram";

const router = express.Router();

const GLOBAL_ID =
  process.env.GLOBAL_CHANNEL_TENANT_ID ||
  "00000000-0000-0000-0000-000000000001"; // fallback seguro

const sha256 = (s: string) =>
  crypto.createHash("sha256").update(String(s || "").trim().toLowerCase()).digest("hex");

// ✅ DEDUPE 7 días (bucket estable). No depende de timezone.
function bucket7DaysUTC(d = new Date()) {
  const ms = d.getTime();
  const windowMs = 7 * 24 * 60 * 60 * 1000;
  return `b7:${Math.floor(ms / windowMs)}`;
}

// ✅ Reserva dedupe en DB usando interactions (unique tenant+canal+message_id)
async function reserveCapiEvent(tenantId: string, eventId: string): Promise<boolean> {
  try {
    const r = await pool.query(
      `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
       VALUES ($1, 'meta_capi', $2, NOW())
       ON CONFLICT (tenant_id, canal, message_id) DO NOTHING
       RETURNING 1`,
      [tenantId, eventId]
    );
    return (r?.rowCount ?? 0) > 0;
  } catch (e: any) {
    console.warn("⚠️ reserveCapiEvent failed:", e?.message);
    return false;
  }
}

// ===============================
// Regex / Parse helpers (igual WA)
// ===============================

// 💳 Confirmación de pago (usuario) — usa tu versión WA (más estricta)
const PAGO_CONFIRM_REGEX =
  /^(?!.*\b(no|aun\s*no|todav[ií]a\s*no|not)\b).*?\b(pago\s*realizado|listo\s*el\s*pago|ya\s*pagu[eé]|he\s*paga(do|do)|payment\s*(done|made|completed)|i\s*paid|paid)\b/i;

const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_REGEX = /(\+?\d[\d\s().-]{7,}\d)/;

function outboundId(messageId: string | null) {
  return messageId ? `${messageId}-out` : null;
}

function extractPaymentLinkFromPrompt(promptBase: string): string | null {
  if (!promptBase) return null;

  const tagged = promptBase.match(/LINK_PAGO:\s*(https?:\/\/\S+)/i);
  if (tagged?.[1]) return tagged[1].replace(/[),.]+$/g, "");

  const any = promptBase.match(/https?:\/\/[^\s)]+/i);
  return any?.[0] ? any[0].replace(/[),.]+$/g, "") : null;
}

function pickSelectedChannelFromText(
  text: string
): "whatsapp" | "instagram" | "facebook" | "multi" | null {
  const t = (text || "").trim().toLowerCase();

  if (/\b(los\s+tres|las\s+tres|todos|todas|all\s+three)\b/i.test(t)) return "multi";

  if (t === "whatsapp" || t === "wa") return "whatsapp";
  if (t === "instagram" || t === "ig") return "instagram";
  if (t === "facebook" || t === "fb") return "facebook";

  const hasWhats = /\bwhats(app)?\b/i.test(t);
  const hasInsta = /\binsta(gram)?\b/i.test(t);
  const hasFace = /\b(face(book)?|fb)\b/i.test(t);

  const count = Number(hasWhats) + Number(hasInsta) + Number(hasFace);

  if (count >= 2) return "multi";
  if (hasWhats) return "whatsapp";
  if (hasInsta) return "instagram";
  if (hasFace) return "facebook";

  return null;
}

// Parse simple: soporta "Nombre Apellido email teléfono país"
function parseDatosCliente(text: string) {
  const raw = (text || "").trim();
  if (!raw) return null;

  const email = raw.match(EMAIL_REGEX)?.[0] || null;
  const phoneRaw = raw.match(PHONE_REGEX)?.[0] || null;
  const telefono = phoneRaw ? phoneRaw.replace(/[^\d+]/g, "") : null;

  if (!email || !telefono) return null;

  let rest = raw.replace(email, " ").replace(phoneRaw || "", " ");
  rest = rest.replace(/\s+/g, " ").trim();

  const parts = rest.split(" ").filter(Boolean);
  if (parts.length < 3) return null;

  const nombre = parts.slice(0, 2).join(" ").trim();
  const pais = parts.slice(2).join(" ").trim();

  if (!nombre || !pais) return null;

  return { nombre, email, telefono, pais };
}

function looksLikeBookingPayload(text: string) {
  const t = String(text || "");
  const hasEmail = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(t);
  const hasDateTime = /\b\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\b/.test(t);
  const hasDateOnly = /\b\d{4}-\d{2}-\d{2}\b/.test(t);
  const hasTimeOnly = /^\s*\d{2}:\d{2}\s*$/.test(t);
  return hasEmail || hasDateTime || hasDateOnly || hasTimeOnly;
}

// ===============================
// Normalizadores de idioma (igual WA)
// ===============================
const normLang = (code?: string | null) => {
  if (!code) return null;
  const base = code.toString().split(/[-_]/)[0].toLowerCase();
  return base === "zxx" ? null : base;
};

const normalizeLang = (code?: string | null): "es" | "en" =>
  (code || "").toLowerCase().startsWith("en") ? "en" : "es";

// ===============================
// DB helpers (alineados a WA)
// ===============================
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
    console.warn("⚠️ ensureClienteBase FAILED", {
      tenantId,
      canal,
      contacto,
      msg: e?.message,
      code: e?.code,
      detail: e?.detail,
      constraint: e?.constraint,
    });
    return false;
  }
}

async function getIdiomaClienteDB(
  tenantId: string,
  canal: string,
  contacto: string,
  fallback: "es" | "en"
): Promise<"es" | "en"> {
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
  idioma: "es" | "en"
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
    console.warn("No se pudo guardar idioma del cliente:", e);
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

function extractBookingLinkFromPrompt(promptBase: string): string | null {
  if (!promptBase) return null;
  const tagged = promptBase.match(/LINK_RESERVA:\s*(https?:\/\/\S+)/i);
  if (tagged?.[1]) return tagged[1].replace(/[),.]+$/g, "");
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

  if (aw.clear) {
    await clearAwaitingState(tenantId, canal, contacto);
  }

  const field = String(aw.field || "");
  const value = aw.value;

  if (field === "select_channel" || field === "canal" || field === "canal_a_automatizar") {
    if (value === "whatsapp" || value === "instagram" || value === "facebook" || value === "multi") {
      await upsertSelectedChannelDB(tenantId, canal as any, contacto, value);
    }
    return;
  }

  if (field === "select_language") {
    if (value === "es" || value === "en") {
      await upsertIdiomaClienteDB(tenantId, canal as any, contacto, value);
    }
    return;
  }
}

// ===============================
// Meta channel gates (mantener)
// ===============================
async function isMetaSubChannelEnabled(tenantId: string, canalEnvio: CanalEnvio): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT facebook_enabled, instagram_enabled
       FROM channel_settings
      WHERE tenant_id = $1 OR tenant_id = $2
      ORDER BY CASE WHEN tenant_id = $1 THEN 0 ELSE 1 END
      LIMIT 1`,
    [tenantId, GLOBAL_ID]
  );

  const row = rows[0];
  if (!row) return true;

  if (canalEnvio === "facebook") return row.facebook_enabled !== false;
  if (canalEnvio === "instagram") return row.instagram_enabled !== false;

  return true;
}

// ===============================
// Socket helpers (mismo contrato WA)
// ===============================
async function saveUserMessageAndEmit(opts: {
  tenantId: string;
  canal: Canal;
  fromNumber: string;
  messageId: string | null;
  content: string;
  intent?: string | null;
  interestLevel?: number | null;
  emotion?: string | null;
}) {
  const { tenantId, canal, fromNumber, messageId, content, intent, interestLevel, emotion } = opts;
  if (!messageId) return;

  try {
    const { rows } = await pool.query(
      `INSERT INTO messages (
        tenant_id, role, content, timestamp, canal, from_number, message_id, intent, interest_level, emotion
      )
      VALUES ($1,'user',$2,NOW(),$3,$4,$5,$6,$7,$8)
      ON CONFLICT (tenant_id, message_id) DO NOTHING
      RETURNING id, timestamp, role, content, canal, from_number, intent, interest_level, emotion`,
      [
        tenantId,
        content,
        canal,
        fromNumber || "anónimo",
        messageId,
        intent ?? null,
        (typeof interestLevel === "number" ? interestLevel : null),
        emotion ?? null,
      ]
    );

    const inserted = rows[0];
    console.log("💾 [DB messages user]", {
      messageId,
      inserted: !!inserted,
      canal,
      fromNumber,
    });
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
      emotion: inserted.emotion,
    });
  } catch (e) {
    console.warn("⚠️ No se pudo registrar mensaje user + socket:", e);
  }
}

async function saveAssistantMessageAndEmit(opts: {
  tenantId: string;
  canal: Canal;
  fromNumber: string;
  messageId: string | null;
  content: string;
  intent?: string | null;
  interestLevel?: number | null;
}) {
  const { tenantId, canal, fromNumber, messageId, content } = opts;

  if (!messageId) return;

  try {
    const finalMessageId = messageId ? `${messageId}-bot` : null;

    const { rows } = await pool.query(
      `INSERT INTO messages (
        tenant_id, role, content, timestamp, canal, from_number, message_id, intent, interest_level
      )
      VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5, $6, $7)
      ON CONFLICT (tenant_id, message_id) DO NOTHING
      RETURNING id, timestamp, role, content, canal, from_number, intent, interest_level`,
      [
        tenantId,
        content,
        canal,
        fromNumber || "anónimo",
        finalMessageId,
        opts.intent ?? null,
        (typeof opts.interestLevel === "number" ? opts.interestLevel : null),
      ]
    );

    const inserted = rows[0];
    console.log("💾 [DB messages assistant]", {
      messageId: finalMessageId,
      inserted: !!inserted,
      canal,
      fromNumber,
    });

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
    });
  } catch (e) {
    console.warn("⚠️ No se pudo registrar mensaje assistant + socket:", e);
  }
}

// ===============================
// History (igual WA)
// ===============================
async function getRecentHistoryForModel(opts: {
  tenantId: string;
  canal: Canal;
  fromNumber: string;
  excludeMessageId?: string | null;
  limit?: number;
}): Promise<ChatCompletionMessageParam[]> {
  const { tenantId, canal, fromNumber, excludeMessageId = null, limit = 12 } = opts;

  try {
    const whereExclude = excludeMessageId ? `AND message_id <> $4` : "";
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
// Memoria (igual WA)
// ===============================
async function rememberAfterReply(opts: {
  tenantId: string;
  canal: Canal;
  senderId: string;
  idiomaDestino: "es" | "en";
  userText: string;
  assistantText: string;
  lastIntent?: string | null;
}) {
  const { tenantId, canal, senderId, idiomaDestino, userText, assistantText, lastIntent } = opts;

  try {
    await rememberTurn({
      tenantId,
      canal: String(canal) as any,
      senderId,
      userText,
      assistantText,
    });

    await rememberFacts({
      tenantId,
      canal: String(canal) as any,
      senderId,
      preferredLang: idiomaDestino,
      lastIntent: lastIntent || null,
    });

    await refreshFactsSummary({
      tenantId,
      canal: String(canal) as any,
      senderId,
      idioma: idiomaDestino,
    });
  } catch (e) {
    console.warn("⚠️ rememberAfterReply failed:", e);
  }
}

// ===============================
// Send Meta with idempotency (similar a safeEnviarWhatsApp)
// ===============================
async function safeEnviarMeta(
  tenantId: string,
  canal: string,
  messageId: string | null,
  toNumber: string,
  text: string,
  accessToken: string
): Promise<boolean> {
  const dedupeId = outboundId(messageId);

  // Sin messageId confiable: envía y cuenta si ok.
  if (!dedupeId) {
    try {
      await enviarMensajePorPartes({
        respuesta: text,
        senderId: toNumber,
        tenantId,
        canal: canal as any,
        messageId: `out_${tenantId}_${canal}_${Date.now()}`,
        accessToken,
      });
      await incrementarUsoPorCanal(tenantId, canal);
      return true;
    } catch (e) {
      console.error("❌ safeEnviarMeta send failed (no dedupeId):", e);
      return false;
    }
  }

  try {
    // ✅ RESERVA ATÓMICA
    const ins = await pool.query(
      `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (tenant_id, canal, message_id) DO NOTHING
       RETURNING 1`,
      [tenantId, canal, dedupeId]
    );

    console.log("🧾 [META OUT RESERVE]", {
      dedupeId,
      reserved: ins.rowCount === 1,
      canal,
      tenantId,
    });

    if (ins.rowCount === 0) {
      console.log("⏩ safeEnviarMeta: ya reservado/enviado outbound. No re-envío ni cuento.");
      return true;
    }

    // ✅ Intentar envío real
    try {
      await enviarMensajePorPartes({
        respuesta: text,
        senderId: toNumber,
        tenantId,
        canal: canal as any,
        messageId: dedupeId,
        accessToken,
      });

      await incrementarUsoPorCanal(tenantId, canal);
      return true;
    } catch (sendErr) {
      // ✅ rollback: libera la reserva para permitir retry real
      await pool.query(
        `DELETE FROM interactions WHERE tenant_id=$1 AND canal=$2 AND message_id=$3`,
        [tenantId, canal, dedupeId]
      );
      console.error("❌ safeEnviarMeta send failed; rolled back reservation:", sendErr);
      return false;
    }
  } catch (e) {
    console.error("❌ safeEnviarMeta error:", e);
    return false;
  }
}

// ===============================
// State machine (igual WA)
// ===============================
const sm = createStateMachine([
  paymentHumanGate,
  yesNoStateGate,
  awaitingGate,
]);

const MAX_LINES_META = 16;

// ===============================
// GET verify (Meta)
// ===============================
router.get("/api/facebook/webhook", requireChannel("meta"), (req, res) => {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "testtoken";
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ Webhook de Facebook verificado");
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
  res.sendStatus(400);
});

// ===============================
// POST Meta (Facebook / Instagram) — pipeline estilo WA
// ===============================
router.post("/api/facebook/webhook", async (req, res) => {
  // Meta exige 200 rápido
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== "page" && body.object !== "instagram") return;

    for (const entry of body.entry || []) {
      const pageId = entry.id;

      for (const messagingEvent of entry.messaging || []) {
        if (!messagingEvent?.message?.text) continue;

        const isEcho = messagingEvent.message.is_echo === true;
        const senderId = String(messagingEvent.sender?.id || "");

        // Evita eco propio (senderId == pageId)
        if (String(senderId) === String(pageId)) continue;

        // Evita procesar echo (control humano lo manejas fuera si lo quieres)
        if (isEcho) continue;

        const messageId: string = messagingEvent.message.mid;
        const userInput: string = messagingEvent.message.text || "";

        if (!messageId || !senderId) continue;
        console.log("📥 [META INBOUND]", {
          object: body.object,
          pageId,
          senderId,
          messageId,
          textLen: userInput?.length || 0,
        });

        // Resolver tenant por pageId
        const { rows } = await pool.query(
          `SELECT t.*
                , m.prompt_meta
                , m.bienvenida_meta
                , t.facebook_access_token
            FROM tenants t
       LEFT JOIN meta_configs m ON t.id = m.tenant_id
           WHERE t.facebook_page_id = $1 OR t.instagram_page_id = $1
           LIMIT 1`,
          [pageId]
        );
        if (!rows.length) continue;

        const tenant = rows[0];
        const tenantId: string = tenant.id;

        const isInstagram = tenant.instagram_page_id && String(tenant.instagram_page_id) === String(pageId);
        const canalEnvio: CanalEnvio = isInstagram ? "instagram" : "facebook";
        const canal: Canal = canalEnvio as any; // para messages/estado

        // ✅ DEDUPE INBOUND (DB) — 1 vez por messageId por tenant+canal
        {
          const r = await pool.query(
            `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (tenant_id, canal, message_id) DO NOTHING
            RETURNING 1`,
            [tenantId, canalEnvio, messageId]
          );

          if ((r.rowCount ?? 0) === 0) {
            console.log("⏩ [META] inbound dedupe: ya procesado messageId", {
              tenantId,
              canalEnvio,
              messageId,
            });
            continue;
          }
        }

        console.log("🏷️ [META TENANT RESOLVED]", {
          tenantId,
          canalEnvio,
          pageId,
          senderId,
          messageId,
        });

        const accessToken = String(tenant.facebook_access_token || "");
        if (!accessToken) {
          console.warn("⚠️ [META] tenant sin facebook_access_token:", { tenantId });
          continue;
        }

        // Gate subcanal (silencio total)
        const subEnabled = await isMetaSubChannelEnabled(tenantId, canalEnvio);
        if (!subEnabled) continue;

        // Gate plan/pausa (silencio total)
        try {
          const gate = await canUseChannel(tenantId, "meta");
          if (!gate.plan_enabled) continue;
          if (gate.reason === "paused") continue;
        } catch (e) {
          console.warn("⚠️ [META] canUseChannel falló; bloqueo por seguridad:", e);
          continue;
        }

        // Gate membresía activa (igual WA en espíritu)
        const estaActiva =
          tenant.membresia_activa === true ||
          tenant.membresia_activa === "true" ||
          tenant.membresia_activa === 1;

        if (!estaActiva) continue;

        const isNewLead = await ensureClienteBase(tenantId, canalEnvio, senderId);

        // ===============================
        // 📡 META CAPI — LEAD (OPCIÓN PRO): solo primer mensaje del contacto
        // ===============================
        try {
          if (isNewLead) {
            const contactHash = sha256(senderId); // PSID/IGSID estable

            const eventId = `lead:${tenantId}:${contactHash}`; // ✅ 1 vez en la vida

            await sendCapiEvent({
              tenantId,
              eventName: "Lead",
              eventId,
              userData: {
                external_id: sha256(`${tenantId}:${senderId}`),
              },
              customData: {
                channel: canalEnvio, // "facebook" | "instagram"
                source: "first_inbound_message",
                inbound_message_id: messageId,
                preview: (userInput || "").slice(0, 80),
                page_id: String(pageId || ""),
              },
            });

            console.log("✅ CAPI Lead enviado (primer mensaje):", { tenantId, canalEnvio, senderId });
          } else {
            console.log("⏭️ CAPI Lead omitido (ya existía cliente):", { tenantId, canalEnvio, senderId });
          }
        } catch (e: any) {
          console.warn("⚠️ Error enviando CAPI Lead PRO:", e?.message);
        }

        // ✅ FOLLOW-UP RESET: si el cliente volvió a escribir, cancela cualquier follow-up pendiente
        try {
          const deleted = await cancelPendingFollowUps({
            tenantId,
            canal: canalEnvio,   // "facebook" | "instagram"
            contacto: senderId,  // PSID/IGSID
          });

          if (deleted > 0) {
            console.log("🧹 [META] follow-ups pendientes cancelados por nuevo inbound:", {
              tenantId,
              canalEnvio,
              senderId,
              deleted,
              messageId,
            });
          }
        } catch (e: any) {
          console.warn("⚠️ [META] cancelPendingFollowUps failed:", e?.message);
        }

        const isNumericOnly = /^\s*\d+\s*$/.test(userInput);
        const isAmbiguous = isNumericOnly || isAmbiguousLangText(userInput);

        const tenantBase: "es" | "en" = normalizeLang(tenant?.idioma || "es");
        let idiomaDestino: "es" | "en" = tenantBase;

        if (isAmbiguous) {
          // ✅ NO detectar idioma con "ok 3", "2pm", "👍", etc.
          idiomaDestino = await getIdiomaClienteDB(tenantId, canalEnvio, senderId, tenantBase);
          console.log(`🌍 [META] idiomaDestino= ${idiomaDestino} fuente= DB (ambiguous)`);
        } else {
          let detectado: string | null = null;
          try {
            detectado = normLang(await detectarIdioma(userInput));
          } catch {}
          const normalizado: "es" | "en" = normalizeLang(detectado || tenantBase);
          await upsertIdiomaClienteDB(tenantId, canalEnvio, senderId, normalizado);
          idiomaDestino = normalizado;
          console.log(`🌍 [META] idiomaDestino= ${idiomaDestino} fuente= userInput`);
        }

        // Prompt base + bienvenida (prioriza meta_configs)
        const promptBase =
          (tenant.prompt_meta && String(tenant.prompt_meta).trim()) ||
          getPromptPorCanal("meta", tenant, idiomaDestino);

        let promptBaseMem = promptBase;

        const bienvenida =
          (tenant.bienvenida_meta && String(tenant.bienvenida_meta).trim()) ||
          getBienvenidaPorCanal(canalEnvio, tenant, idiomaDestino);

        // conversation_state (igual WA)
        const st = await getOrInitConversationState({
          tenantId,
          canal,
          senderId,
          defaultFlow: "generic_sales",
          defaultStep: "start",
        });

        let activeFlow = st.active_flow || "generic_sales";
        let activeStep = st.active_step || "start";
        let convoCtx = st.context && typeof st.context === "object" ? st.context : {};

        function transition(params: { flow?: string; step?: string; patchCtx?: any }) {
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
            [tenantId]
          );
          bookingEnabled = rows[0]?.google_calendar_enabled === true;
        } catch (e: any) {
          console.warn("⚠️ [META] No se pudo leer google_calendar_enabled:", e?.message);
        }

        console.log("🧠 [META] facts_summary (start of turn) -> about to fetch", {
          tenantId,
          canalEnvio,
          senderId,
        });

        // ✅ MEMORIA: inyectar facts_summary al promptBaseMem (igual WA)
        try {
          const memRaw = await getMemoryValue<any>({
            tenantId,
            canal: String(canalEnvio) as any,
            senderId,
            key: "facts_summary",
          });

          const memText =
            typeof memRaw === "string"
              ? memRaw
              : (memRaw && typeof memRaw === "object" && typeof memRaw.text === "string")
                ? memRaw.text
                : "";
          console.log("🧠 [META] facts_summary =", memText);

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
          console.warn("⚠️ [META] No se pudo cargar memoria:", e);
        }

        let lastIntent: string | null = null;
        let nivelInteres: number | null = null;
        let INTENCION_FINAL_CANONICA: string | null = null;

        // ===============================
        // 🎯 Intent detection (evento por mensaje) — MOVER AQUÍ
        // ===============================
        try {
          const det = await detectarIntencion(userInput, tenantId, canalEnvio as any);
          INTENCION_FINAL_CANONICA = det?.intencion ? String(det.intencion) : null;
          lastIntent = INTENCION_FINAL_CANONICA;

          const ni = Number(det?.nivel_interes);
          nivelInteres = Number.isFinite(ni) ? Math.max(1, Math.min(3, ni)) : null;

          console.log("🎯 [META] detectarIntencion =>", {
            intent: INTENCION_FINAL_CANONICA,
            nivelInteres,
            canalEnvio,
            tenantId,
            messageId,
          });

          transition({
            patchCtx: {
              last_intent: INTENCION_FINAL_CANONICA,
              last_interest_level: nivelInteres,
            },
          });
        } catch (e) {
          console.warn("⚠️ detectarIntencion failed:", e);
        }

        // ===============================
        // Single-exit variables + helpers (DEBEN existir antes de triggers)
        // ===============================
        let handled = false;
        let reply: string | null = null;
        let replySource: string | null = null;
        let replied = false;
        let sentOk = false;

        function setReply(text: string, source: string, intent?: string | null) {
          replied = true;
          handled = true;
          reply = text;
          replySource = source;
          if (intent !== undefined) lastIntent = intent;
        }

        const setConversationStateCompat = async (
          tId: string,
          c: any,
          senderKey: string,
          state: { activeFlow: string | null; activeStep: string | null; context?: any }
        ) => {
          await setConversationStateDB({
            tenantId: tId,
            canal: c,
            senderId: senderKey,
            activeFlow: state.activeFlow ?? null,
            activeStep: state.activeStep ?? null,
            contextPatch: state.context ?? {},
          });
        };

        async function finalizeReply() {
          console.log("✅ [FINALIZE START]", {
            handled,
            hasReply: !!reply,
            replySource,
            lastIntent,
            nivelInteres,
            messageId,
            senderId,
            canalEnvio,
          });

          await finalizeReplyLib(
            {
              handled,
              reply,
              replySource,
              lastIntent,

              tenantId,
              canal,
              messageId,
              fromNumber: senderId,
              contactoNorm: senderId,
              userInput,

              idiomaDestino,

              activeFlow,
              activeStep,
              convoCtx,

              intentFallback: INTENCION_FINAL_CANONICA || null,

              onAfterOk: (nextCtx) => {
                convoCtx = nextCtx;
              },
            },
            {
              safeSend: async (tId, _c2, mId, toNumber, text) => {
                const ok = await safeEnviarMeta(tId, canalEnvio, mId, toNumber, text, accessToken);
                sentOk = ok;
                return ok;
              },
              setConversationState: setConversationStateCompat,

              saveAssistantMessageAndEmit: async (opts: any) =>
                saveAssistantMessageAndEmit({
                  ...opts,
                  canal,
                  intent: (lastIntent || INTENCION_FINAL_CANONICA || null),
                  interestLevel: (typeof nivelInteres === "number" ? nivelInteres : null),
                }),

              rememberAfterReply: async (opts: any) =>
                rememberAfterReply({ ...opts, canal, senderId }),
            }
          );
          console.log("✅ [FINALIZE DONE]", {
            sentOk,
            replySource,
            lastIntent,
            nivelInteres,
            messageId,
            senderId,
            canalEnvio,
          });

          // ✅ evento de ventas solo si realmente se envió
          try {
            if (!handled || !reply || !sentOk) return;

            const finalIntent = (lastIntent || INTENCION_FINAL_CANONICA || "")
              .toString()
              .trim()
              .toLowerCase();

            const finalNivel =
              typeof nivelInteres === "number"
                ? Math.min(3, Math.max(1, nivelInteres))
                : 2;

            if (messageId && finalIntent && esIntencionDeVenta(finalIntent) && finalNivel >= 2) {
              await recordSalesIntent({
                tenantId,
                contacto: senderId,
                canal: canalEnvio as any,
                mensaje: userInput,
                intencion: finalIntent,
                nivelInteres: finalNivel,
                messageId,
              });
            }

            // ===============================
            // 📡 META CAPI — QUALIFIED LEAD (#2): Contact (1 vez por contacto)
            // ===============================
            try {
              if (!handled || !reply || !sentOk) return;

              const finalIntent = (lastIntent || INTENCION_FINAL_CANONICA || "")
                .toString()
                .trim()
                .toLowerCase();

              const finalNivel =
                typeof nivelInteres === "number"
                  ? Math.min(3, Math.max(1, nivelInteres))
                  : 2;

              if (messageId && finalIntent && esIntencionDeVenta(finalIntent) && finalNivel >= 2) {
                const contactHash = sha256(senderId); // PSID/IGSID estable
                const eventId = `ql:${tenantId}:${contactHash}`; // ✅ 1 vez en la vida

                await sendCapiEvent({
                  tenantId,
                  eventName: "Contact",
                  eventId,
                  userData: {
                    external_id: sha256(`${tenantId}:${senderId}`),
                  },
                  customData: {
                    channel: canalEnvio,
                    intent: finalIntent,
                    interest_level: finalNivel,
                    inbound_message_id: messageId,
                    page_id: String(pageId || ""),
                  },
                });

                console.log("✅ [META] CAPI Contact (#2) enviado:", {
                  tenantId,
                  canalEnvio,
                  senderId,
                  finalIntent,
                  finalNivel,
                  eventId,
                });
              }
            } catch (e: any) {
              console.warn("⚠️ [META] Error enviando CAPI Contact (#2):", e?.message);
            }

            // ===============================
            // 📡 META CAPI — EVENTO #3 (ULTRA-UNIVERSAL): Lead (solo intención FUERTE)
            // Dedupe: 1 vez por contacto cada 7 días
            // ===============================
            try {
              if (!handled || !reply || !sentOk) return;

              const finalIntent = (lastIntent || INTENCION_FINAL_CANONICA || "")
                .toString()
                .trim()
                .toLowerCase();

              const finalNivel =
                typeof nivelInteres === "number"
                  ? Math.min(3, Math.max(1, nivelInteres))
                  : 1;

              // SOLO intención fuerte
              if (messageId && finalIntent && esIntencionDeVenta(finalIntent) && finalNivel >= 3) {
                // En Meta no siempre tienes teléfono. Usa senderId como identificador estable del contacto.
                const contactHash = sha256(senderId);

                const eventId = `leadstrong:${tenantId}:${contactHash}:${bucket7DaysUTC()}`;
                const ok = await reserveCapiEvent(tenantId, eventId);

                if (ok) {
                  await sendCapiEvent({
                    tenantId,
                    eventName: "Lead", // ✅ "cliente potencial" en inglés
                    eventId,
                    userData: {
                      external_id: sha256(`${tenantId}:${senderId}`),
                    },
                    customData: {
                      channel: canalEnvio, // "facebook" | "instagram"
                      source: "sales_intent_strong",
                      intent: finalIntent,
                      interest_level: finalNivel,
                      inbound_message_id: messageId,
                      page_id: pageId,
                    },
                  });

                  console.log("✅ [META] CAPI Lead (#3 fuerte) enviado:", { tenantId, canalEnvio, senderId, finalIntent, finalNivel, eventId });
                } else {
                  console.log("⏭️ [META] CAPI Lead (#3 fuerte) deduped:", { tenantId, canalEnvio, senderId, eventId });
                }
              }
            } catch (e: any) {
              console.warn("⚠️ [META] Error enviando CAPI evento #3 Lead fuerte:", e?.message);
            }

            const bookingStep = (convoCtx as any)?.booking?.step;
            const inBooking = bookingStep && bookingStep !== "idle";
            const bookingJustCompleted = !!(convoCtx as any)?.booking_completed;

            const skipFollowUp =
              inBooking ||
              bookingJustCompleted ||
              finalIntent === "agendar_cita";

            try {
              await scheduleFollowUpIfEligible({
                tenant,
                canal: canalEnvio,
                contactoNorm: senderId,
                idiomaDestino,
                intFinal: finalIntent || null,
                nivel: finalNivel,
                userText: userInput,
                skip: skipFollowUp, // ✅ IGUAL WA
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
        }

        // selected_channel flag (igual WA)
        const decisionFlags = { channelSelected: false };
        const selectedChannel = await getSelectedChannelDB(tenantId, canalEnvio, senderId);
        if (selectedChannel) decisionFlags.channelSelected = true;

        // ✅ Emotion detection (antes de guardar inbound)
        let emotion: string | null = null;
      
        try {
          const emoRaw: any = await detectarEmocion(userInput, idiomaDestino);

          emotion =
            typeof emoRaw === "string"
              ? emoRaw
              : (emoRaw?.emotion || emoRaw?.emocion || emoRaw?.label || null);

          emotion = typeof emotion === "string" ? emotion.trim().toLowerCase() : null;
          console.log("🎭 [META] detectarEmocion =>", {
            emotion,
            canalEnvio,
            tenantId,
            messageId,
          });
        } catch (e) {
          console.warn("⚠️ detectarEmocion failed:", e);
        }

        // Save inbound user message (igual WA)
        await saveUserMessageAndEmit({
          tenantId,
          canal,
          fromNumber: senderId,
          messageId,
          content: userInput,
          intent: lastIntent,
          interestLevel: nivelInteres,
          emotion, // ✅ aquí
        });

        // ===============================
        // 🎭 EMOTION TRIGGERS (acciones, no config) — META
        // ===============================
        try {
          // Normaliza emotion por si detectarEmocion devuelve objeto
          const trig = await applyEmotionTriggers({
            tenantId,
            canal: canalEnvio as any,
            contacto: senderId,
            emotion, // ✅ ya viene normalizado
            intent: lastIntent,
            interestLevel: nivelInteres,
          });

          if (trig?.ctxPatch) {
            transition({ patchCtx: trig.ctxPatch });
          }

          // Si requiere handoff, responde 1 vez y sale por Single Exit
          if (trig?.action === "handoff_human" && trig.replyOverride) {
            await replyAndExit(trig.replyOverride, "emotion_trigger", lastIntent);
            continue; // 👈 importante en Meta (loop)
          }
        } catch (e: any) {
          console.warn("⚠️ [META] applyEmotionTriggers failed:", e?.message);
        }

        // ===============================
        // 📅 BOOKING GATE (Google Calendar) — ANTES del SM/LLM
        // ===============================
        const bookingLink = extractBookingLinkFromPrompt(promptBase);

        // ✅ Si el toggle está OFF, nunca ejecutes bookingFlowMvp (y limpia estados viejos)
        if (!bookingEnabled) {
          if ((convoCtx as any)?.booking) {
            transition({ patchCtx: { booking: null } });
            await setConversationStateCompat(tenantId, canal, senderId, {
              activeFlow,
              activeStep,
              context: { booking: null },
            });
          }
        } else {
          const bookingStep = (convoCtx as any)?.booking?.step;
          const inBooking = bookingStep && bookingStep !== "idle";

          const bk = await bookingFlowMvp({
            tenantId,
            canal: canalEnvio,     // ✅ "facebook" | "instagram"
            contacto: senderId,    // PSID/IGSID
            idioma: idiomaDestino,
            userText: userInput,
            ctx: convoCtx,
            bookingLink,
            messageId,
          });

          if (bk?.ctxPatch) transition({ patchCtx: bk.ctxPatch });

          if (bk?.handled) {
            // ✅ FIX CRÍTICO: persiste el ctx del booking ANTES de salir
            await setConversationStateCompat(tenantId, canal, senderId, {
              activeFlow,
              activeStep,
              context: convoCtx,
            });
            await replyAndExit(
              bk.reply || (idiomaDestino === "en" ? "Ok." : "Perfecto."),
              "booking_flow",
              "agendar_cita"
            );
            continue; // 👈 importantísimo en el loop Meta
          }
        }

        // ===============================
        // ✅ POST-BOOKING COURTESY GUARD (igual WA)
        // ===============================
        {
          const lastDoneAt = (convoCtx as any)?.booking_last_done_at;
          const completedAtISO = (convoCtx as any)?.booking_completed_at;

          const lastMs =
            typeof lastDoneAt === "number"
              ? lastDoneAt
              : (typeof completedAtISO === "string" ? Date.parse(completedAtISO) : null);

          if (lastMs && Number.isFinite(lastMs)) {
            const seconds = (Date.now() - lastMs) / 1000;

            if (seconds >= 0 && seconds < 10 * 60) {
              const t = (userInput || "").toString().trim().toLowerCase();

              const courtesy =
                /^(gracias|muchas gracias|thank you|thanks|ok|okay|perfecto|listo|vale|dale|bien|genial|super|cool)$/i.test(t);

              if (courtesy) {
                const replyText = idiomaDestino === "en" ? "You’re welcome." : "A la orden.";
                await replyAndExit(replyText, "post_booking_courtesy", "cortesia");
                continue;
              }
            }
          }
        }

        const bookingStep0 = (convoCtx as any)?.booking?.step;
        const inBooking0 = bookingStep0 && bookingStep0 !== "idle";

        // 👋 GREETING GATE (igual WA defensivo)
        if (
          !inBooking0 &&
          saludoPuroRegex.test(userInput) &&
          !looksLikeBookingPayload(userInput)
        ) {
          transition({
            step: "answer",
            patchCtx: {
              reset_reason: "greeting",
              last_user_text: userInput,
              last_bot_action: "welcome_sent",
              last_reply_source: "welcome_gate",
              last_assistant_text: bienvenida,
            },
          });

          await replyAndExit(bienvenida, "welcome_gate", "saludo");
          continue;
        }

        // ===============================
        // 🧠 STATE MACHINE (igual WA)
        // ===============================
        const smResult = await sm({
          pool,
          tenantId,
          canal,
          contacto: senderId,
          userInput,
          messageId,
          idiomaDestino,
          promptBase, // sin memoria (para link pago)
          parseDatosCliente,
          extractPaymentLinkFromPrompt,
          PAGO_CONFIRM_REGEX,
          detectedIntent: INTENCION_FINAL_CANONICA,
        } as any);

        if (smResult.action === "silence") {
          console.log("🧱 [SM META] silence:", smResult.reason);
          continue;
        }

        if (smResult.action === "reply") {
          if (smResult.transition?.effects) {
            await applyAwaitingEffects({
              tenantId,
              canal,
              contacto: senderId,
              effects: smResult.transition.effects,
            });
          }

          const history = await getRecentHistoryForModel({
            tenantId,
            canal,
            fromNumber: senderId,
            excludeMessageId: messageId,
            limit: 12,
          });

          const composed = await answerWithPromptBase({
            tenantId,
            promptBase: promptBaseMem,
            userInput: [
              "SYSTEM_EVENT_FACTS (use to respond; do not mention systems; keep it short):",
              JSON.stringify(smResult.facts || {}),
              "",
              "USER_MESSAGE:",
              userInput,
            ].join("\n"),
            history,
            idiomaDestino,
            canal: canalEnvio as any,
            maxLines: MAX_LINES_META,
            fallbackText: bienvenida,
          });

          await replyAndExit(composed.text, smResult.replySource || "state_machine", smResult.intent || null);
          continue;
        }

        // ===============================
        // 🛡️ Anti-phishing (igual WA)
        // ===============================
        {
          let phishingReply: string | null = null;

          const handledPhishing = await antiPhishingGuard({
            pool,
            tenantId,
            channel: canalEnvio,
            senderId,
            messageId,
            userInput,
            idiomaDestino,
            send: async (text: string) => {
              phishingReply = text;
            },
          });

          if (handledPhishing) {
            transition({
              flow: "generic_sales",
              step: "close",
              patchCtx: { guard: "phishing", last_bot_action: "blocked_phishing" },
            });

            await replyAndExit(
              phishingReply || (idiomaDestino === "en" ? "Got it." : "Perfecto."),
              "phishing",
              "seguridad"
            );
            continue;
          }
        }

        // ===============================
        // ✅ Canal elegido (igual WA)
        // ===============================
        if (!decisionFlags.channelSelected) {
          const picked = pickSelectedChannelFromText(userInput);
          if (picked) {
            await upsertSelectedChannelDB(tenantId, canalEnvio, senderId, picked);
            decisionFlags.channelSelected = true;
          }
        }

        // ===============================
        // ✅ FALLBACK ÚNICO (igual WA)
        // ===============================
        if (!replied) {
          const history = await getRecentHistoryForModel({
            tenantId,
            canal,
            fromNumber: senderId,
            excludeMessageId: messageId,
            limit: 12,
          });

          const composed = await answerWithPromptBase({
            tenantId,
            promptBase: promptBaseMem,
            userInput: [
              INTENCION_FINAL_CANONICA ? `INTENCION_DETECTADA: ${INTENCION_FINAL_CANONICA}` : "",
              userInput
            ].filter(Boolean).join("\n"),
            history,
            idiomaDestino,
            canal: canalEnvio as any,
            maxLines: MAX_LINES_META,
            fallbackText: bienvenida,
          });

          setReply(composed.text, "sm-fallback");
          await finalizeReply();
        }
      }
    }
  } catch (error: any) {
    console.error("❌ Error en webhook Meta:", error);
  }
});

export default router;
