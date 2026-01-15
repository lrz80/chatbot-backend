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

type CanalEnvio = "facebook" | "instagram";

const router = express.Router();

const GLOBAL_ID =
  process.env.GLOBAL_CHANNEL_TENANT_ID ||
  "00000000-0000-0000-0000-000000000001"; // fallback seguro

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
async function ensureClienteBase(tenantId: string, canal: string, contacto: string) {
  try {
    await pool.query(
      `
      INSERT INTO clientes (tenant_id, canal, contacto, created_at, updated_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      ON CONFLICT (tenant_id, canal, contacto)
      DO UPDATE SET updated_at = NOW()
      `,
      [tenantId, canal, contacto]
    );
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
}) {
  const { tenantId, canal, fromNumber, messageId, content } = opts;
  if (!messageId) return;

  try {
    const { rows } = await pool.query(
      `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
       VALUES ($1, 'user', $2, NOW(), $3, $4, $5)
       ON CONFLICT (tenant_id, message_id) DO NOTHING
       RETURNING id, timestamp, role, content, canal, from_number`,
      [tenantId, content, canal, fromNumber || "anónimo", messageId]
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
}) {
  const { tenantId, canal, fromNumber, messageId, content } = opts;

  try {
    const finalMessageId = messageId ? `${messageId}-bot` : null;

    const { rows } = await pool.query(
      `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
       VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
       ON CONFLICT (tenant_id, message_id) DO NOTHING
       RETURNING id, timestamp, role, content, canal, from_number`,
      [tenantId, content, canal, fromNumber || "anónimo", finalMessageId]
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
  toNumber: string, // senderId
  text: string,
  accessToken: string
): Promise<boolean> {
  try {
    const dedupeId = outboundId(messageId);

    const messageIdSeguro =
      (typeof messageId === 'string' && messageId.trim() ? messageId : null) ||
      (typeof dedupeId === 'string' && dedupeId.trim() ? dedupeId : null) ||
      `out_${tenantId}_${canal}_${Date.now()}`;

    if (!dedupeId) {
      await enviarMensajePorPartes({
        respuesta: text,
        senderId: toNumber,
        tenantId,
        canal: canal as any,
        messageId: messageIdSeguro,
        accessToken,
      });
      await incrementarUsoPorCanal(tenantId, canal);
      return true;
    }

    const ins = await pool.query(
      `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (tenant_id, canal, message_id) DO NOTHING
       RETURNING 1`,
      [tenantId, canal, dedupeId]
    );

    if (ins.rowCount === 0) {
      console.log("⏩ safeEnviarMeta: ya reservado/enviado outbound. No re-envío ni cuento.");
      return true;
    }

    await enviarMensajePorPartes({
      respuesta: text,
      senderId: toNumber,
      tenantId,
      canal: canal as any,
      messageId: messageIdSeguro,
      accessToken,
    });

    await incrementarUsoPorCanal(tenantId, canal);
    return true;
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

// Dedupe por MID (inbound)
const mensajesProcesados = new Set<string>();

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
        const recipientId = String(messagingEvent.recipient?.id || "");

        // Evita eco propio (senderId == pageId)
        if (String(senderId) === String(pageId)) continue;

        // Evita procesar echo (control humano lo manejas fuera si lo quieres)
        if (isEcho) continue;

        const messageId: string = messagingEvent.message.mid;
        const userInput: string = messagingEvent.message.text || "";

        if (!messageId || !senderId) continue;

        // Dedupe inbound
        if (mensajesProcesados.has(messageId)) continue;
        mensajesProcesados.add(messageId);
        setTimeout(() => mensajesProcesados.delete(messageId), 60_000);

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

        // Idioma (igual WA)
        const isNumericOnly = /^\s*\d+\s*$/.test(userInput);
        const tenantBase: "es" | "en" = normalizeLang(tenant?.idioma || "es");

        let idiomaDestino: "es" | "en" = tenantBase;

        await ensureClienteBase(tenantId, canalEnvio, senderId);

        if (isNumericOnly) {
          idiomaDestino = await getIdiomaClienteDB(tenantId, canalEnvio, senderId, tenantBase);
        } else {
          let detectado: string | null = null;
          try {
            detectado = normLang(await detectarIdioma(userInput));
          } catch {}
          const normalizado: "es" | "en" = normalizeLang(detectado || tenantBase);
          await upsertIdiomaClienteDB(tenantId, canalEnvio, senderId, normalizado);
          idiomaDestino = normalizado;
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

        // selected_channel flag (igual WA)
        const decisionFlags = { channelSelected: false };
        const selectedChannel = await getSelectedChannelDB(tenantId, canalEnvio, senderId);
        if (selectedChannel) decisionFlags.channelSelected = true;

        // Memoria start
        const memStart = await getMemoryValue<string>({
          tenantId,
          canal: String(canalEnvio) as any,
          senderId,
          key: "facts_summary",
        });
        console.log("🧠 [META] facts_summary (start of turn) =", memStart);

        // Save inbound user message (igual WA)
        await saveUserMessageAndEmit({
          tenantId,
          canal,
          fromNumber: senderId,
          messageId,
          content: userInput,
        });

        // ===============================
        // Single-exit variables (igual WA)
        // ===============================
        let handled = false;
        let reply: string | null = null;
        let replySource: string | null = null;
        let lastIntent: string | null = null;
        let replied = false;
        let INTENCION_FINAL_CANONICA: string | null = null;

        function setReply(text: string, source: string, intent?: string | null) {
          replied = true;
          handled = true;
          reply = text;
          replySource = source;
          if (intent !== undefined) lastIntent = intent;
        }

        // ===============================
        // 🎯 Intent detection (DB + LLM fallback)
        // ===============================
        try {
          const det = await detectarIntencion(userInput, tenantId, canalEnvio as any);
          INTENCION_FINAL_CANONICA = det.intencion;
          lastIntent = det.intencion;

          // Si quieres usar el nivel para lógica adicional:
          // const nivelInteres = det.nivel_interes;

          // Guarda en contexto para debugging/flows si quieres
          transition({
            patchCtx: {
              last_intent: det.intencion,
              last_interest_level: det.nivel_interes,
            },
          });
        } catch (e) {
          console.warn("⚠️ detectarIntencion failed:", e);
        }

        // Inyectar facts_summary a prompt (igual WA)
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
              : memRaw && typeof memRaw === "object" && typeof memRaw.text === "string"
                ? memRaw.text
                : "";

          if (memText.trim()) {
            promptBaseMem = [
              promptBase,
              "",
              "MEMORIA_DEL_CLIENTE (usa esto solo si ayuda a responder mejor; no lo inventes):",
              memText.trim(),
            ].join("\n");
          }
        } catch (e) {
          console.warn("⚠️ [META] No se pudo cargar memoria:", e);
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
              safeEnviarWhatsApp: async (
                tId: string,
                c2: string,
                mId: string | null,
                toNumber: string,
                text: string
              ) => safeEnviarMeta(tId, c2, mId, toNumber, text, accessToken),

              setConversationState: setConversationStateCompat,

              saveAssistantMessageAndEmit: async (opts: any) =>
                saveAssistantMessageAndEmit({ ...opts, canal }),

              rememberAfterReply: async (opts: any) =>
                rememberAfterReply({ ...opts, canal, senderId }),
            }
          );
        }

        async function replyAndExit(text: string, source: string, intent?: string | null) {
          setReply(text, source, intent);
          await finalizeReply();
        }

        // ===============================
        // 👋 GREETING GATE (igual WA)
        // ===============================
        if (saludoPuroRegex.test(userInput)) {
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

          setReply(composed.text, "sm-fallback", null);
          await finalizeReply();
        }
      }
    }
  } catch (error: any) {
    console.error("❌ Error en webhook Meta:", error);
  }
});

export default router;
