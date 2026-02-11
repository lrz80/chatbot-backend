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
import { getMemoryValue } from "../../lib/clientMemory";
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
import { detectarEmocion } from "../../lib/detectarEmocion";
import { applyEmotionTriggers } from "../../lib/guards/emotionTriggers";
import { scheduleFollowUpIfEligible, cancelPendingFollowUps } from "../../lib/followups/followUpScheduler";
import { humanOverrideGate } from "../../lib/guards/humanOverrideGate";
import { setHumanOverride } from "../../lib/humanOverride/setHumanOverride";
import { saveAssistantMessageAndEmit } from "../../lib/channels/engine/messages/saveAssistantMessageAndEmit";
import { saveUserMessageAndEmit } from "../../lib/channels/engine/messages/saveUserMessageAndEmit";
import { getRecentHistoryForModel } from "../../lib/channels/engine/messages/getRecentHistoryForModel";
import { safeSendText } from "../../lib/channels/engine/dedupe/safeSendText";
import { applyAwaitingEffects } from "../../lib/channels/engine/state/applyAwaitingEffects";
import {
  PAGO_CONFIRM_REGEX,
  extractPaymentLinkFromPrompt,
  looksLikeBookingPayload,
  pickSelectedChannelFromText,
  parseDatosCliente,
} from "../../lib/channels/engine/parsers/parsers";
import {
  capiLeadFirstInbound,
} from "../../lib/analytics/capiEvents";
import type { Lang } from "../../lib/channels/engine/clients/clientDb";
import {
  normalizeLang,
  ensureClienteBase,
  getIdiomaClienteDB,
  upsertIdiomaClienteDB,
  getSelectedChannelDB,
  upsertSelectedChannelDB,
} from "../../lib/channels/engine/clients/clientDb";
import { resolveTurnLangClientFirst } from "../../lib/channels/engine/lang/resolveTurnLang";
import { runPostReplyActions } from "../../lib/conversation/postReplyActions";
import { runBookingPipeline } from "../../lib/appointments/booking/bookingPipeline";
import { postBookingCourtesyGuard } from "../../lib/appointments/booking/postBookingCourtesyGuard";
import { rememberAfterReply } from "../../lib/memory/rememberAfterReply";
import { getWhatsAppModeStatus } from "../../lib/whatsapp/getWhatsAppModeStatus";
import {
  isAskingIncludes,
  findServiceBlock,
  extractIncludesLine,
} from "../../lib/infoclave/resolveIncludes";
import { getPriceInfoForService } from "../../lib/services/pricing/getFromPriceForService";
import { resolveServiceIdFromText } from "../../lib/services/pricing/resolveServiceIdFromText";
import { isExplicitHumanRequest } from "../../lib/security/humanOverrideGate";
import { resolveServiceInfo } from "../../lib/services/resolveServiceInfo";
import { traducirMensaje } from "../../lib/traducirMensaje";

// Puedes ponerlo debajo de los imports
export type WhatsAppContext = {
  tenant?: any;
  canal?: string;
  origen?: "twilio" | "meta";
};

const MAX_WHATSAPP_LINES = 16; // 14–16 es el sweet spot

function isPriceQuestion(text: string) {
  const t = String(text || "").toLowerCase();
  return /\b(precio|precios|cu[aá]nto\s+cuesta|cu[aá]nto\s+vale|costo|cost|price|how\s+much|starts?\s+at|from|desde)\b/i.test(t);
}

const router = Router();
const MessagingResponse = twilio.twiml.MessagingResponse;

// BOOKING HELPERS
const BOOKING_TZ = "America/New_York";

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

  // ⚡ No hacemos 2 queries a DB: cache local del turno
  const waModePromise = getWhatsAppModeStatus(tenant.id);

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

  const isNewLead = await ensureClienteBase(pool, tenant.id, canal, contactoNorm);

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
      await upsertIdiomaClienteDB(pool, tenant.id, canal, contactoNorm, forcedLang);
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
  // ===============================
  const storedLang = await getIdiomaClienteDB(pool, tenant.id, canal, contactoNorm, tenantBase);

  const langRes = await resolveTurnLangClientFirst({
    pool,
    tenantId: tenant.id,
    canal,
    contacto: contactoNorm,
    userInput,
    tenantBase,
    storedLang,
    detectarIdioma,
    convoCtx,
  });

  // 🛑 LANGUAGE HARD LOCK: if user writes in one language, force it
  if (!storedLang) {
    try {
      const detected = await detectarIdioma(userInput);
      if (detected === "es" || detected === "en") {
        idiomaDestino = detected;
        await upsertIdiomaClienteDB(pool, tenant.id, canal, contactoNorm, detected);
        console.log("🌍 FORCED LANGUAGE (no storedLang) =", detected);
      }
    } catch {}
  }

  idiomaDestino = langRes.finalLang;

  console.log("🌍 LANG DEBUG =", {
    userInput,
    tenantBase,
    storedLang,
    detectedLang: langRes.detectedLang,
    lockedLang: langRes.lockedLang,
    inBookingLang: langRes.inBookingLang,
    idiomaDestino,
  });

  // ✅ LANG LOCK: si ya hay idioma del hilo, NO dejes que tokens cortos lo cambien
  const threadLang = String((convoCtx as any)?.thread_lang || "").toLowerCase();
  const threadLocked = (convoCtx as any)?.thread_lang_locked === true;

  if (threadLocked && (threadLang === "es" || threadLang === "en")) {
    idiomaDestino = threadLang as any;
  }

  const t = String(userInput || "").trim().toLowerCase();
  const isSizeToken = /^(small|medium|large|x-large|xl|xs|peque(n|ñ)o|mediano|grande)$/i.test(t);

  if (isSizeToken && (storedLang === "es" || storedLang === "en")) {
    idiomaDestino = storedLang as any;
  }

  // ✅ thread_lang SOLO durante booking
  if (langRes.inBookingLang && !(convoCtx as any)?.thread_lang) {
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
        rememberAfterReply: (args: any) =>
        rememberAfterReply({
          ...args,
          canal: "whatsapp",
          replySource: (args?.replySource ?? args?.source ?? null),
        }),
      }
    );

    try {
      if (!handled || !reply) return;

      await runPostReplyActions({
        pool,
        tenant,
        tenantId: tenant.id,
        canal,

        contactoNorm,
        fromNumber: fromNumber || null,
        messageId: messageId || null,
        userInput: userInput || "",

        idiomaDestino,

        lastIntent,
        intentFallback: INTENCION_FINAL_CANONICA || null,

        detectedInterest,

        convoCtx,
      });
    } catch (e: any) {
      console.warn("⚠️ runPostReplyActions failed:", e?.message);
    }
  }

  async function replyAndExit(text: string, source: string, intent?: string | null) {
    setReply(text, source, intent);
    await finalizeReply();
    return;
  }

  // ===============================
  // 📅 BOOKING helper (reduce duplicación)
  // ===============================
  async function tryBooking(mode: "gate" | "guardrail", tag: string) {
    const bk = await runBookingPipeline({
      pool,
      tenantId: tenant.id,
      canal: "whatsapp",
      contacto: contactoNorm,
      idioma: idiomaDestino,
      userText: userInput,
      messageId: messageId || null,

      ctx: convoCtx,
      transition,

      bookingEnabled,
      promptBase,

      detectedIntent: detectedIntent || INTENCION_FINAL_CANONICA || null,

      mode,
      sourceTag: tag,

      persistState: async (nextCtx) => {
        await setConversationStateCompat(tenant.id, canal, contactoNorm, {
          activeFlow,
          activeStep,
          context: nextCtx,
        });
        convoCtx = nextCtx;
      },
    });

    if (bk.handled) {
      await replyAndExit(bk.reply, bk.source, bk.intent);
      return true;
    }
    return false;
  }

  if (await tryBooking("gate", "pre_sm")) return;

  const bookingStep0 = (convoCtx as any)?.booking?.step;
  const inBooking0 = bookingStep0 && bookingStep0 !== "idle";

  const awaiting = (convoCtx as any)?.awaiting || activeStep || null;

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
    pool,
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

  const { mode, status } = await waModePromise;

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
  } catch (e: any) {
    console.warn("⚠️ applyEmotionTriggers failed:", e?.message);
  }
  
  // ========================================================
    // 🚫 Human Override YA NO VIENE de emociones
    // 🚸 SOLO SI EL USUARIO LO PIDE EXPLÍCITAMENTE (“quiero hablar con alguien”)
    // ========================================================
    if (isExplicitHumanRequest(userInput)) {
      await setHumanOverride({
        tenantId: tenant.id,
        canal,
        contacto: contactoNorm,
        minutes: 5,
        reason: "explicit_request",
        source: "explicit_request",
        customerPhone: fromNumber || contactoNorm,
        userMessage: userInput,
        messageId: messageId || null,
      });

      return await replyAndExit(
        "Entiendo. Para ayudarte mejor, te contactará una persona del equipo en un momento.",
        "human_override_explicit",
        detectedIntent
      );
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
    const c = postBookingCourtesyGuard({ ctx: convoCtx, userInput, idioma: idiomaDestino });
    if (c.hit) return await replyAndExit(c.reply, "post_booking_courtesy", "cortesia");
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
      await upsertIdiomaClienteDB(pool, tenant.id, canal, contactoNorm, forcedLang);

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
    const bienvenida = await getBienvenidaPorCanal("whatsapp", tenant, idiomaDestino);

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

  // ===============================
  // ✅ INFO_CLAVE GATE (reutilizable por cualquier canal)
  // ===============================
  {
    const infoClave = String(tenant?.info_clave || "").trim();

    if (infoClave && isAskingIncludes(userInput)) {
      const blk = findServiceBlock(infoClave, userInput);

      if (blk) {
        const inc = extractIncludesLine(blk.lines);

        if (inc) {
          const msg =
            idiomaDestino === "en"
              ? `✅ ${blk.title}\nIncludes: ${inc}`
              : `✅ ${blk.title}\nIncluye: ${inc}`;

          return await replyAndExit(msg, "info_clave_includes", detectedIntent || "info");
        }

        const msg =
          idiomaDestino === "en"
            ? `I found "${blk.title}", but the service details are not loaded yet.`
            : `Encontré "${blk.title}", pero aún no tengo cargado qué incluye.`;

        return await replyAndExit(msg, "info_clave_missing_includes", detectedIntent || "info");
      }

      // ❗ NO cortes el flujo aquí.
      // Si INFO_CLAVE no matchea, dejamos que el catálogo DB (resolveServiceInfo)
      // intente resolver "qué incluye" sin preguntar cosas redundantes.
      console.log("ℹ️ INFO_CLAVE: includes asked but no block matched; falling through to DB fastpath.");
    }
  }

  // ===============================
  // ✅ INCLUDES FASTPATH (DB catalog) — usa resolveServiceInfo
  // Si INFO_CLAVE no resolvió, intenta responder desde services/service_variants
  // ===============================
  if (!inBooking0 && isAskingIncludes(userInput)) {
    const r = await resolveServiceInfo({
      tenantId: tenant.id,
      query: userInput,
      need: "includes", // ✅ clave: evita pedir variante si el service base tiene description
      limit: 5,
    });

    if (r.ok) {
      // guarda contexto para próximas preguntas (precio / booking)
      transition({
        patchCtx: {
          last_service_id: r.service_id,
          last_service_name: r.label,
          last_service_at: Date.now(), // ✅ TTL
        },
      });

      if (r.description && String(r.description).trim()) {
        let descOut = String(r.description).trim();

        try {
          const idOut = await detectarIdioma(descOut);

          // Solo soportamos ES ↔ EN
          if (
            (idOut === "es" || idOut === "en") &&
            idOut !== idiomaDestino
          ) {
            descOut = await traducirMensaje(descOut, idiomaDestino);
          }
        } catch (e: any) {
          console.warn("⚠️ includes_fastpath_db translation failed:", e?.message || e);
        }

        const msg =
          idiomaDestino === "en"
            ? `✅ ${r.label}\nIncludes: ${descOut}`
            : `✅ ${r.label}\nIncluye: ${descOut}`;

        return await replyAndExit(msg, "includes_fastpath_db", detectedIntent || "info");
      }

      const msg =
        idiomaDestino === "en"
          ? `I found "${r.label}", but I don’t have the service details loaded yet.`
          : `Encontré "${r.label}", pero aún no tengo cargado qué incluye.`;

      return await replyAndExit(msg, "includes_fastpath_db_missing", detectedIntent || "info");
    }

    // Ambiguo: pide aclaración sin inventar
    if (r.reason === "ambiguous" && r.options?.length) {
      const opts = r.options.slice(0, 5).map((o) => `• ${o.label}`).join("\n");

      const ask =
        idiomaDestino === "en"
          ? `Which one do you mean?\n${opts}`
          : `¿Cuál de estos es?\n${opts}`;

      return await replyAndExit(ask, "includes_fastpath_db_ambiguous", detectedIntent || "info");
    }
  }

  // ===============================
  // ✅ PRICE FASTPATH (DB) — NO dependas del LLM para "DESDE"
  // ===============================
  function formatMoney(amount: number, currency: string) {
    const a = Math.round(amount);
    if (currency === "USD") return `$${a}`;
    return `${a} ${currency}`;
  }

  function renderPriceReply(args: {
    lang: "es" | "en";
    mode: "fixed" | "from";
    amount: number;
    currency: string;
    serviceName?: string | null;
    options?: Array<{ label: string; amount: number; currency: string }>;
    optionsCount?: number;
  }) {
    const money = formatMoney(args.amount, args.currency);

    const name =
      args.serviceName && String(args.serviceName).trim()
        ? String(args.serviceName).trim()
        : null;

    const hasOptions = Array.isArray(args.options) && args.options.length > 0;

    const fmtLine = (o: { label: string; amount: number; currency: string }) => {
      const m = formatMoney(o.amount, o.currency || args.currency);
      return `• ${String(o.label || "Opción").trim()}: ${m}`;
    };

    // ======================
    // FIXED (price_base)
    // ======================
    if (args.mode === "fixed") {
      if (args.lang === "en") {
        return name
          ? `✅ ${name}: ${money}\n\nIf you tell me the service or product name you’re looking for, I can help you better.`
          : `✅ Price: ${money}\n\nIf you tell me the service or product name you’re looking for, I can help you better.`;
      }

      return name
        ? `✅ ${name}: ${money}\n\nSi me dices el nombre del servicio o producto que buscas, te puedo ayudar mejor.`
        : `✅ El precio es ${money}\n\nSi me dices el nombre del servicio o producto que buscas, te puedo ayudar mejor.`;
    }

    // ======================
    // FROM (variants)
    // ======================
    // Si hay variantes, responde tipo lista (TOP 5) sin suponer tamaño/booking.
    if (args.lang === "en") {
      if (hasOptions) {
        const header = name ? `✅ ${name} — starts at ${money}` : `✅ Starts at ${money}`;
        const list = args.options!.map(fmtLine).join("\n");
        const more =
          typeof args.optionsCount === "number" && args.optionsCount > args.options!.length
            ? `\n…plus ${args.optionsCount - args.options!.length} more option(s).`
            : "";

        return `${header}\n\nOptions:\n${list}${more}\n\nWhich option are you interested in?`;
      }

      // no options (pero sí "from")
      return name
        ? `✅ ${name} — starts at ${money}\n\nIf you tell me the exact option name, I can help you better.`
        : `✅ Starts at ${money}\n\nIf you tell me the service/product name, I can help you better.`;
    }

    // ES
    if (hasOptions) {
      const header = name ? `✅ ${name} — desde ${money}` : `✅ Desde ${money}`;
      const list = args.options!.map(fmtLine).join("\n");
      const more =
        typeof args.optionsCount === "number" && args.optionsCount > args.options!.length
          ? `\n…y ${args.optionsCount - args.options!.length} opción(es) más.`
          : "";

      return `${header}\n\nOpciones:\n${list}${more}\n\n¿Cuál opción te interesa?`;
    }

    // no options (pero sí "from")
    return name
      ? `✅ ${name} — desde ${money}\n\nSi me dices el nombre exacto de la opción, te puedo ayudar mejor.`
      : `✅ Desde ${money}\n\nSi me dices el nombre del servicio o producto que buscas, te puedo ayudar mejor.`;
  }

  if (!inBooking0 && isPriceQuestion(userInput)) {
    // A) si ya lo tienes en contexto (ideal)
    const LAST_SERVICE_TTL_MS = 60 * 60 * 1000; // 60 min (ajusta si quieres)

    let serviceId: string | null = (convoCtx as any)?.last_service_id || null;
    let serviceName: string | null = (convoCtx as any)?.last_service_name || null;
    const lastAt = Number((convoCtx as any)?.last_service_at || 0);

    if (serviceId && lastAt && Number.isFinite(lastAt)) {
      const age = Date.now() - lastAt;
      if (age > LAST_SERVICE_TTL_MS) {
        // expiró → no uses contexto viejo
        serviceId = null;
        serviceName = null;

        transition({
          patchCtx: {
            last_service_id: null,
            last_service_name: null,
            last_service_at: null,
          },
        });
      }
    }

    // B) si no hay contexto, intenta resolver por texto contra services
    if (!serviceId) {
      const hit = await resolveServiceIdFromText(pool, tenant.id, userInput);
      if (hit?.id) {
        serviceId = hit.id;
        serviceName = hit.name;

        // guarda para próximas vueltas
        transition({
          patchCtx: {
            last_service_id: serviceId,
            last_service_name: serviceName,
            last_service_at: Date.now(), // ✅ TTL
          },
        });
      }
    }

    if (serviceId) {
      const pi = await getPriceInfoForService(pool, tenant.id, serviceId);

      // ✅ Si no hay precio resoluble, no suenes a error ni digas "no tengo precios cargados"
      if (!pi.ok) {
        const msg =
          idiomaDestino === "en"
            ? "To provide an accurate price, I just need to confirm which service you're interested in. Which one would you like to check?"
            : "Para darte un precio exacto, necesito identificar el servicio específico. ¿Cuál deseas consultar?";

        return await replyAndExit(msg, "price_missing_db", detectedIntent || "precio");
      }

      // ✅ Precio válido (fixed/from)
      const msg = renderPriceReply({
        lang: idiomaDestino === "en" ? "en" : "es",
        mode: pi.mode,
        amount: pi.amount,
        currency: (pi.currency || "USD").toUpperCase(),
        serviceName: serviceName || null,
        options: (pi as any).options,
        optionsCount: (pi as any).optionsCount,
      });

      // ✅ IMPORTANT: si estamos haciendo una pregunta de confirmación (sí/no),
      // seteamos awaiting para que el siguiente "sí" no se pierda.
      if (pi.mode === "fixed") {
        const { setAwaitingState } = await import("../../lib/awaiting/setAwaitingState");
        await setAwaitingState(pool, {
          tenantId: tenant.id,
          canal,
          senderId: contactoNorm,
          field: "yes_no",
          payload: { kind: "confirm_booking", source: "price_fastpath_db", serviceId },
          ttlSeconds: 600,
        });
      }

      return await replyAndExit(msg, "price_fastpath_db", detectedIntent || "precio");
    }
  }

  // ✅ PRICE SUMMARY (DB): pregunta genérica → resumen (rango + ejemplos), NO lista completa
  if (!inBooking0 && isPriceQuestion(userInput)) {
    const askedGeneric =
      // ES
      /\b(cu[aá]les\s+son\s+los\s+precios|precios\s*\?|precios\b)\b/i.test(userInput) ||
      // EN
      /\b(what\s+are\s+the\s+prices|prices\s*\?)\b/i.test(userInput);

    if (askedGeneric) {
      // Trae precios desde services y service_variants (sin depender de un servicio específico)
      const { rows } = await pool.query(
        `
        WITH base AS (
          SELECT
            s.id AS service_id,
            s.name AS service_name,
            s.price_base::numeric AS price
          FROM services s
          WHERE s.tenant_id = $1
            AND s.active = true
            AND s.price_base IS NOT NULL

          UNION ALL

          SELECT
            v.service_id,
            s.name AS service_name,
            v.price::numeric AS price
          FROM service_variants v
          JOIN services s ON s.id = v.service_id
          WHERE s.tenant_id = $1
            AND s.active = true
            AND v.active = true
            AND v.price IS NOT NULL
        ),
        agg AS (
          SELECT
            service_id,
            service_name,
            MIN(price) AS min_price,
            MAX(price) AS max_price
          FROM base
          GROUP BY service_id, service_name
        )
        SELECT
          (SELECT MIN(min_price) FROM agg) AS overall_min,
          (SELECT MAX(max_price) FROM agg) AS overall_max,
          service_id,
          service_name,
          min_price,
          max_price
        FROM agg
        ORDER BY min_price ASC
        LIMIT 5;
        `,
        [tenant.id]
      );
      console.log("🧪 PRICE_SUMMARY_DB_ROWS =", JSON.stringify(rows, null, 2));

      const overallMin = rows?.[0]?.overall_min != null ? Number(rows[0].overall_min) : null;
      const overallMax = rows?.[0]?.overall_max != null ? Number(rows[0].overall_max) : null;

      // si no hay precios cargados en DB, no inventes
      if (!overallMin || !overallMax) {
        const msg =
          idiomaDestino === "en"
            ? "I don’t have the pricing loaded in our catalog yet. Which specific service are you interested in?"
            : "Aún no tengo los precios cargados en el catálogo. ¿Qué servicio específico te interesa?";
        return await replyAndExit(msg, "price_summary_db_empty", detectedIntent || "precio");
      }

      const fmt = (n: number) => `$${Math.round(n)}`;

      // arma 3–5 ejemplos (sin listar todo)
      const examples = rows
        .filter((r: any) => r?.service_name)
        .map((r: any) => {
          const name = String(r.service_name);
          const minP = Number(r.min_price);
          const maxP = Number(r.max_price);

          // si min==max => precio fijo; si no => "desde"
          if (Number.isFinite(minP) && Number.isFinite(maxP) && Math.round(minP) === Math.round(maxP)) {
            return idiomaDestino === "en"
              ? `${name}: ${fmt(minP)}`
              : `${name}: ${fmt(minP)}`;
          }

          return idiomaDestino === "en"
            ? `${name}: starts at ${fmt(minP)}`
            : `${name}: desde ${fmt(minP)}`;
        });

      const header =
        idiomaDestino === "en"
          ? `Prices range from ${fmt(overallMin)} to ${fmt(overallMax)}.`
          : `Los precios van desde ${fmt(overallMin)} hasta ${fmt(overallMax)}.`;

      const ask =
        idiomaDestino === "en"
          ? "Which service are you interested in?"
          : "¿Qué servicio te interesa?";

      const msg = [header, "", ...examples, "", ask].join("\n");
      return await replyAndExit(msg, "price_summary_db", detectedIntent || "precio");
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
        pool,
        tenantId: event.tenantId,
        canal: event.canal,
        contacto: event.contacto,
        effects: smResult.transition.effects,
        upsertSelectedChannelDB: (tenantId, canal, contacto, selected) =>
        upsertSelectedChannelDB(pool, tenantId, canal, contacto, selected),
        upsertIdiomaClienteDB: (tenantId, canal, contacto, idioma) =>
        upsertIdiomaClienteDB(pool, tenantId, canal, contacto, idioma),
      });
    }

    const history = await getRecentHistoryForModel({
      tenantId: tenant.id,
      canal,
      fromNumber: contactoNorm, // ✅ usa fromNumber real
      excludeMessageId: messageId,
      limit: 12,
    });

    if (await tryBooking("guardrail", "sm_reply")) return;

    const NO_NUMERIC_MENUS =
      idiomaDestino === "en"
        ? "RULE: Do NOT present numbered menus or ask the user to reply with a number. If you need clarification, ask ONE short question. Numbered picks are handled by the system, not you."
        : "REGLA: NO muestres menús numerados ni pidas que respondan con un número. Si necesitas aclarar, haz UNA sola pregunta corta. Las selecciones por número las maneja el sistema, no tú.";

    const LIST_FOLLOWUP_RULE =
      idiomaDestino === "en"
        ? "RULE: If you provide a list of services/options, ALWAYS end with ONE short question: 'Which one are you interested in?'"
        : "REGLA: Si das una lista de servicios/opciones, SIEMPRE termina con UNA pregunta corta: '¿Cuál te interesa?'";

    const PRICE_QUALIFIER_RULE =
      idiomaDestino === "en"
        ? "RULE: If a price is described as 'FROM/STARTING AT' (or 'desde'), you MUST keep that qualifier. Never rewrite it as an exact price. Use: 'starts at $X' / 'from $X'."
        : "REGLA: Si un precio está descrito como 'DESDE' (o 'from/starting at'), DEBES mantener ese calificativo. Nunca lo conviertas en precio exacto. Usa: 'desde $X'.";

    const NO_PRICE_INVENTION_RULE =
      idiomaDestino === "en"
        ? "RULE: Do not invent exact prices. Only mention prices if explicitly present in the provided business info, and preserve ranges/qualifiers."
        : "REGLA: No inventes precios exactos. Solo menciona precios si están explícitos en la info del negocio, y preserva rangos/calificativos (DESDE).";

    // 🚫 ROLLBACK: PROMPT-ONLY (sin DB catalog)
    const fallbackWelcome = await getBienvenidaPorCanal("whatsapp", tenant, idiomaDestino);

    const composed = await answerWithPromptBase({
      tenantId: event.tenantId,
      promptBase: [
        promptBaseMem,
        "",
        NO_NUMERIC_MENUS,
        LIST_FOLLOWUP_RULE,
        PRICE_QUALIFIER_RULE,
        NO_PRICE_INVENTION_RULE,
      ].join("\n"),
      userInput: ["USER_MESSAGE:", event.userInput].join("\n"),
      history,
      idiomaDestino,
      canal: "whatsapp",
      maxLines: MAX_WHATSAPP_LINES,
      fallbackText: fallbackWelcome,
    });

    replied = true;

    const textOut = String(composed.text || "").trim();

    // detector GENÉRICO (no industria)
    const looksYesNoQuestion =
      /\?\s*$/.test(textOut) &&
      (
        /\b(te gustar[ií]a|quieres|deseas)\b/i.test(textOut) ||
        /\b(would you like|do you want)\b/i.test(textOut)
      );

    if (looksYesNoQuestion) {
      const { setAwaitingState } = await import("../../lib/awaiting/setAwaitingState");
      await setAwaitingState(pool, {
        tenantId: tenant.id,
        canal,
        senderId: contactoNorm,
        field: "yes_no",
        payload: { kind: "confirm_generic", source: "llm" },
        ttlSeconds: 600,
      });
    }

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
      await upsertSelectedChannelDB(pool, tenant.id, canal, contactoNorm, picked);
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

    if (await tryBooking("guardrail", "sm_fallback")) return;

    const NO_NUMERIC_MENUS =
      idiomaDestino === "en"
        ? "RULE: Do NOT present numbered menus or ask the user to reply with a number. If you need clarification, ask ONE short question. Numbered picks are handled by the system, not you."
        : "REGLA: NO muestres menús numerados ni pidas que respondan con un número. Si necesitas aclarar, haz UNA sola pregunta corta. Las selecciones por número las maneja el sistema, no tú.";

    const PRICE_QUALIFIER_RULE =
      idiomaDestino === "en"
        ? "RULE: If a price is described as 'FROM/STARTING AT' (or 'desde'), you MUST keep that qualifier. Never rewrite it as an exact price. Use: 'starts at $X' / 'from $X'."
        : "REGLA: Si un precio está descrito como 'DESDE' (o 'from/starting at'), DEBES mantener ese calificativo. Nunca lo conviertas en precio exacto. Usa: 'desde $X'.";

    const NO_PRICE_INVENTION_RULE =
      idiomaDestino === "en"
        ? "RULE: Do not invent exact prices. Only mention prices if explicitly present in the provided business info, and preserve ranges/qualifiers."
        : "REGLA: No inventes precios exactos. Solo menciona precios si están explícitos en la info del negocio, y preserva rangos/calificativos (DESDE).";

    // 🚫 ROLLBACK: PROMPT-ONLY (sin DB catalog)
    const fallbackWelcome = await getBienvenidaPorCanal("whatsapp", tenant, idiomaDestino);

    const composed = await answerWithPromptBase({
      tenantId: event.tenantId,
      promptBase: [
        promptBaseMem,
        "",
        NO_NUMERIC_MENUS,
        PRICE_QUALIFIER_RULE,
        NO_PRICE_INVENTION_RULE,
      ].join("\n"),
      userInput: ["USER_MESSAGE:", event.userInput].join("\n"),
      history,
      idiomaDestino,
      canal: "whatsapp",
      maxLines: MAX_WHATSAPP_LINES,
      fallbackText: fallbackWelcome,
    });

    setReply(composed.text, "sm-fallback");
    await finalizeReply();
    return;
  }
}