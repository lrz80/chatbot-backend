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
import { incrementarUsoPorCanal } from '../../lib/incrementUsage';
import { rememberTurn } from "../../lib/memory/rememberTurn";
import { rememberFacts } from "../../lib/memory/rememberFacts";
import { getMemoryValue } from "../../lib/clientMemory";
import { refreshFactsSummary } from "../../lib/memory/refreshFactsSummary";
import {
  setConversationState as setConversationStateDB,
  getOrInitConversationState,
} from "../../lib/conversationState";
import { finalizeReply as finalizeReplyLib } from "../../lib/conversation/finalizeReply";
import { whatsappModeMembershipGuard } from "../../lib/guards/whatsappModeMembershipGuard";
import { paymentHumanGate } from "../../lib/guards/paymentHumanGuard";
import { yesNoStateGate } from "../../lib/guards/yesNoStateGate";
import { buildTurnContext } from "../../lib/conversation/buildTurnContext";
import { awaitingGate } from "../../lib/guards/awaitingGate";
import { createStateMachine } from "../../lib/conversation/stateMachine";
import { recordSalesIntent } from "../../lib/sales/recordSalesIntent";
import { detectarEmocion } from "../../lib/detectarEmocion";
import { applyEmotionTriggers } from "../../lib/guards/emotionTriggers";
import { scheduleFollowUpIfEligible, cancelPendingFollowUps } from "../../lib/followups/followUpScheduler";
import { bookingFlowMvp } from "../../lib/appointments/bookingFlow";
import crypto from "crypto";
import { runBookingGuardrail } from "../../lib/appointments/booking/guardrail";
import { humanOverrideGate } from "../../lib/guards/humanOverrideGate";
import { setHumanOverride } from "../../lib/humanOverride/setHumanOverride";
import { saveAssistantMessageAndEmit } from "../../lib/channels/engine/messages/saveAssistantMessageAndEmit";
import { saveUserMessageAndEmit } from "../../lib/channels/engine/messages/saveUserMessageAndEmit";
import { getRecentHistoryForModel } from "../../lib/channels/engine/messages/getRecentHistoryForModel";
import { safeSendText } from "../../lib/channels/engine/dedupe/safeSendText";
import { applyAwaitingEffects } from "../../lib/channels/engine/state/applyAwaitingEffects";
import {
  PAGO_CONFIRM_REGEX,
  EMAIL_REGEX,
  PHONE_REGEX,
  extractPaymentLinkFromPrompt,
  looksLikeBookingPayload,
  parsePickNumber,
  pickSelectedChannelFromText,
  parseDatosCliente,
} from "../../lib/channels/engine/parsers/parsers";
import {
  capiLeadFirstInbound,
  capiContactQualified,
  capiLeadStrongWeekly,
} from "../../lib/analytics/capiEvents";
import { handleServicesFastpath } from "../../lib/services/fastpath/handleServicesFastpath";

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

const MAX_WHATSAPP_LINES = 16; // 14–16 es el sweet spot

const router = Router();
const MessagingResponse = twilio.twiml.MessagingResponse;

// Normalizadores
const normLang = (code?: string | null) => {
  if (!code) return null;
  const base = code.toString().split(/[-_]/)[0].toLowerCase();
  return base === 'zxx' ? null : base; // zxx = sin lenguaje
};
type Lang = "es" | "en";

const normalizeLang = (code?: string | null): Lang => {
  const base = String(code || "").toLowerCase().split(/[-_]/)[0];
  return base === "en" ? "en" : "es";
};

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
  fallback: Lang
): Promise<Lang> {
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
  idioma: Lang
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
  const tenantBase: Lang = normalizeLang(tenant?.idioma || "es");
  let idiomaDestino: Lang = tenantBase;

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

  // ✅ FORZAR IDIOMA EN PRIMER MENSAJE (o saludo claro)
  // Evita que "hello" use el storedLang viejo en ES.
  try {
    const t0 = String(userInput || "").trim().toLowerCase();
    const isClearHello = /^(hello|hi|hey)\b/i.test(t0);
    const isClearHola  = /^(hola|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches)\b/i.test(t0);

    if (isNewLead || isClearHello || isClearHola) {
      // detectarIdioma aquí debe devolver es|en
      const forced = await detectarIdioma(userInput);

      // Si el saludo es clarísimo, sobreescribe por seguridad
      const forcedLang: Lang =
        isClearHello ? "en" :
        isClearHola  ? "es" :
        forced;

      // Guardar idioma sticky ANTES de bienvenida
      await upsertIdiomaClienteDB(tenant.id, canal, contactoNorm, forcedLang);
      idiomaDestino = forcedLang;

      // Si estás en booking y tienes thread_lang, no lo toques aquí.
      console.log("🌍 LANG FORCED (first/hello) =", {
        isNewLead,
        userInput,
        forced,
        forcedLang,
        idiomaDestino,
      });
    }
  } catch (e: any) {
    console.warn("⚠️ LANG FORCE failed:", e?.message);
  }

  await capiLeadFirstInbound({
    pool,
    tenantId: tenant.id,
    canal: "whatsapp",
    contactoNorm,
    fromNumber,
    messageId: messageId || null,
    preview: userInput || "",
    isNewLead,
  });

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
  // 🌍 LANG RESOLUTION (CLIENT-FIRST)
  // Sticky per contacto + autodetect per turno
  // ===============================

  // 1) idioma guardado del cliente (si existe)
  const storedLang = await getIdiomaClienteDB(tenant.id, canal, contactoNorm, tenantBase);

  // 2) detectar idioma del mensaje (SOLO "es" | "en")
  // ⚠️ override para mensajes cortos típicos (evita false negatives)
  let detectedLang: "es" | "en" | null = null;

  try {
    const t0 = String(userInput || "").trim().toLowerCase();

    // Si es corto/ambiguo, NO fuerces idioma con el detector
    // (usa el storedLang o tenantBase)
    const isAmbiguousShort =
      t0.length <= 2 ||
      /^(ok|okay|k|👍|yes|no|si|sí|hola|hello|hi|hey|thanks|thank you)$/i.test(t0);

    if (!isAmbiguousShort) {
      // detectarIdioma DEBE devolver solo "es" o "en"
      detectedLang = await detectarIdioma(userInput);
    }
  } catch {}

  // 3) lock SOLO durante booking (fuera de booking, nunca bloquees idioma)
  const bookingStepLang = (convoCtx as any)?.booking?.step;
  const inBookingLang = bookingStepLang && bookingStepLang !== "idle";

  const lockedLang =
    inBookingLang
      ? ((convoCtx as any)?.booking?.lang || (convoCtx as any)?.thread_lang || null)
      : null;

  // 4) regla final (ES/EN únicamente)
  // - si hay lock => usa lock
  // - si NO hay detectedLang => usa storedLang o tenantBase
  // - si detectedLang => úsalo y persiste
  let finalLang: "es" | "en" = tenantBase;

  if (lockedLang === "en" || lockedLang === "es") {
    finalLang = lockedLang;
  } else if (!detectedLang) {
    finalLang = storedLang || tenantBase;
  } else {
    finalLang = detectedLang;
    await upsertIdiomaClienteDB(tenant.id, canal, contactoNorm, finalLang);
  }

  // ✅ set idiomaDestino del turno
  idiomaDestino = finalLang;

  console.log("🌍 LANG DEBUG =", {
    userInput,
    tenantBase,
    storedLang,
    detectedLang,
    lockedLang,
    inBookingLang,
    idiomaDestino,
  });

  // ✅ thread_lang SOLO durante booking
  if (inBookingLang && !(convoCtx as any)?.thread_lang) {
    convoCtx = { ...(convoCtx || {}), thread_lang: idiomaDestino };
  }

  const promptBase = getPromptPorCanal("whatsapp", tenant, idiomaDestino);
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

  const safeSend = (tenantId: string, canal: string, messageId: string | null, toNumber: string, text: string) =>
    safeSendText({
      pool,
      tenantId,
      canal,
      messageId,
      to: toNumber,
      text,
      send: enviarWhatsApp,               // ✅ Twilio WhatsApp sender
      incrementUsage: incrementarUsoPorCanal,
    });

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
          await capiContactQualified({
            tenantId: tenant.id,
            canal: "whatsapp",
            contactoNorm,
            fromNumber,
            messageId,
            finalIntent,
            finalNivel,
          });
        }
      } catch (e: any) {
        console.warn("⚠️ Error en CAPI Contact wrapper:", e?.message);
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

        if (messageId && finalIntent && esIntencionDeVenta(finalIntent) && finalNivel >= 3) {
          await capiLeadStrongWeekly({
            pool,
            tenantId: tenant.id,
            canal: "whatsapp",
            contactoNorm,
            fromNumber,
            messageId,
            finalIntent,
            finalNivel,
          });
        }
      } catch (e: any) {
        console.warn("⚠️ Error en CAPI LeadStrong wrapper:", e?.message);
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

  // ===============================
  // ⚡ SERVICES FAST-PATH (link/info/list/prices + picks) — SIN LLM
  // ===============================
  {
    const svc = await handleServicesFastpath({
      pool,
      tenantId: tenant.id,
      canal,
      contacto: contactoNorm,
      userInput,
      idiomaDestino,
      convoCtx,

      transition: ({ patchCtx, flow, step }) => transition({ patchCtx, flow, step }),

      persistState: async ({ context }) => {
        await setConversationStateCompat(tenant.id, canal, contactoNorm, {
          activeFlow,
          activeStep,
          context,
        });
      },

      replyAndExit: async (text, source, intent) => {
        await replyAndExit(text, source, intent);
      },
    });

    if (svc.handled) return;
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

  // ✅ PRE-GREETING LANG FORCE (para hello/hi/hey)
  if (!inBooking0) {
    const t0 = String(userInput || "").trim().toLowerCase();

    const isHello = /^(hello|hi|hey)\b/i.test(t0);
    const isHola =
      /^(hola|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches)\b/i.test(t0);

    if (isHello || isHola) {
      const forcedLang: Lang = isHello ? "en" : "es";
      idiomaDestino = forcedLang;

      // 🔒 Persistir para que quede sticky para ese contacto
      await upsertIdiomaClienteDB(tenant.id, canal, contactoNorm, forcedLang);

      console.log("🌍 PRE-GREETING FORCED LANG =", {
        userInput,
        forcedLang,
        contactoNorm,
      });
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
        upsertSelectedChannelDB,
        upsertIdiomaClienteDB,
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