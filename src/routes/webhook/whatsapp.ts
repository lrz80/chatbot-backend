// backend/src/routes/webhook/whatsapp.ts

import { Router, Request, Response } from 'express';
import pool from '../../lib/db';
import twilio from 'twilio';
import { getPromptPorCanal, getBienvenidaPorCanal } from '../../lib/getPromptPorCanal';
import { detectarIdioma } from '../../lib/detectarIdioma';
import { enviarWhatsApp } from "../../lib/senders/whatsapp";
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
import { scheduleFollowUpIfEligible, cancelPendingFollowUps } from "../../lib/followups/followUpScheduler";
import { humanOverrideGate } from "../../lib/guards/humanOverrideGate";
import { saveAssistantMessageAndEmit } from "../../lib/channels/engine/messages/saveAssistantMessageAndEmit";
import { getRecentHistoryForModel } from "../../lib/channels/engine/messages/getRecentHistoryForModel";
import { safeSendText } from "../../lib/channels/engine/dedupe/safeSendText";
import {
  looksLikeBookingPayload,
  pickSelectedChannelFromText,
} from "../../lib/channels/engine/parsers/parsers";
import {
  capiLeadFirstInbound,
} from "../../lib/analytics/capiEvents";
import type { Lang } from "../../lib/channels/engine/clients/clientDb";
import {
  normalizeLang,
  ensureClienteBase,
  upsertIdiomaClienteDB,
  getSelectedChannelDB,
  upsertSelectedChannelDB,
} from "../../lib/channels/engine/clients/clientDb";
import { resolveLangForTurn } from "../../lib/channels/engine/lang/resolveLangForTurn";
import { runPostReplyActions } from "../../lib/conversation/postReplyActions";
import { postBookingCourtesyGuard } from "../../lib/appointments/booking/postBookingCourtesyGuard";
import { rememberAfterReply } from "../../lib/memory/rememberAfterReply";
import { getWhatsAppModeStatus } from "../../lib/whatsapp/getWhatsAppModeStatus";
import {
  handleFastpathHybridTurn,
} from "../../lib/channels/engine/fastpath/handleFastpathHybridTurn";
import { handleStateMachineTurn } from "../../lib/channels/engine/sm/handleStateMachineTurn";
import { handleUserSignalsTurn } from "../../lib/channels/engine/turn/handleUserSignalsTurn";
import { handleBookingTurn } from "../../lib/channels/engine/booking/handleBookingTurn";
import { parseDatosCliente } from "../../lib/parseDatosCliente";

import { runEstimateFlowTurn } from "../../lib/estimateFlow/runEstimateFlowTurn";
import { traducirMensaje } from '../../lib/traducirMensaje';
import { queryWithTimeout } from "../../lib/dbQuery";
import {
  resolveServiceCandidatesFromText,
} from "../../lib/services/pricing/resolveServiceIdFromText";

// Puedes ponerlo debajo de los imports
export type WhatsAppContext = {
  tenant?: any;
  canal?: string;
  origen?: "twilio" | "meta";
};

const MAX_WHATSAPP_LINES = 9999; // 14–16 es el sweet spot

const router = Router();
const MessagingResponse = twilio.twiml.MessagingResponse;

// 🛡️ Cache en memoria para dedupe de inbound (texto+contacto+tenant)
const inboundDedupCache = new Map<string, number>();

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
    console.log("🔥 webhook POST recibido", {
      at: new Date().toISOString(),
      hasBody: !!req.body,
      messageSid: req.body?.MessageSid || null,
      from: req.body?.From || null,
    });

    setTimeout(() => {
      console.log("🔥 entrando a procesarMensajeWhatsApp", {
        at: new Date().toISOString(),
        messageSid: req.body?.MessageSid || null,
      });

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

  console.log("A0 antes buildTurnContext");

  const turn = await buildTurnContext({ pool, body, context });

  console.log("A0.1 despues buildTurnContext");

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
  let forcedLangThisTurn: Lang | null = null;

  const normalizeChoice = (s: string) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const isChoosingFromCtxLists = (ctx: any, userText: string) => {
    const u = normalizeChoice(userText);
    if (!u) return false;

    const candidates: Array<{ name?: string; label?: string; text?: string }> = [
      ...((ctx?.last_plan_list || []) as any[]),
      ...((ctx?.last_package_list || []) as any[]),
      ...((ctx?.last_service_list || []) as any[]),
      ...((ctx?.pending_link_options || []) as any[]), // ✅ importante para tu flujo ambiguous
    ];

    if (!candidates.length) return false;

    // Si el user manda "1" o "2" para escoger
    if (/^[1-9]$/.test(u)) return true;

    return candidates.some((it) => {
      const n = normalizeChoice(it?.name || it?.label || it?.text || "");
      if (!n) return false;
      return n.includes(u) || u.includes(n);
    });
  };

  const origen = turn.origen;

  const numero = turn.numero;
  const numeroSinMas = turn.numeroSinMas;

  const fromNumber = turn.fromNumber;
  const contactoNorm = turn.contactoNorm;

  // ===============================
  // 🛡️ GATE ANTI-DUPLICADOS (texto + contacto + tenant)
  // ===============================
  {
    const text = String(userInput || "").trim();
    const contactKey = String(contactoNorm || fromNumber || numero || "").trim();

    if (tenant && text && contactKey) {
      const normalize = (s: string) =>
        String(s || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();

      const normText = normalize(text);
      const key = `${tenant.id}:${canal}:${contactKey}:${normText}`;

      const now = Date.now();
      const ttlMs = 15_000; // ventana de 15s para evitar reintentos de Twilio

      const last = inboundDedupCache.get(key);

      if (typeof last === "number" && now - last >= 0 && now - last < ttlMs) {
        console.log("🚫 inbound dedupe: mensaje duplicado reciente, se omite procesamiento", {
          key,
          diffMs: now - last,
        });
        // No seguimos con fastpath / LLM / Twilio send
        return;
      }

      inboundDedupCache.set(key, now);
    }
  }

  if (messageId) {
    console.log("A1 antes dedupe interactions");

  const r = await queryWithTimeout(
    `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (tenant_id, canal, message_id) DO NOTHING
    RETURNING 1`,
    [tenant.id, canal, messageId],
    12000
  );

  console.log("A2 despues dedupe interactions");
    if (r.rowCount === 0) {
      console.log("⏩ inbound dedupe: ya procesado messageId", messageId);
      return;
    }
  }

  console.log("B1 antes ensureClienteBase");

  const isNewLead = await ensureClienteBase(pool, tenant.id, canal, contactoNorm);

  console.log("B2 despues ensureClienteBase");

  // ✅ FORZAR IDIOMA SOLO en saludo inicial claro
  // No usar detectarIdioma aquí para forzar cualquier turno.
  // La resolución general la hace resolveLangForTurn().
  try {
    const t0 = String(userInput || "").trim().toLowerCase();
    const isClearHello = /^(hello|hi|hey)\b/i.test(t0);
    const isClearHola = /^(hola|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches)\b/i.test(t0);

    let forcedLang: Lang | null = null;

    if (isClearHello) forcedLang = "en";
    else if (isClearHola) forcedLang = "es";

    // Solo forzamos si realmente es saludo claro.
    // isNewLead por sí solo NO debe forzar idioma si el mensaje no lo deja claro.
    if (forcedLang) {
      await upsertIdiomaClienteDB(pool, tenant.id, canal, contactoNorm, forcedLang);
      idiomaDestino = forcedLang;
      forcedLangThisTurn = forcedLang;

      console.log("🌍 LANG FORCED (clear greeting) =", {
        isNewLead,
        userInput,
        forcedLang,
        idiomaDestino,
      });
    }
  } catch (e: any) {
    console.error("❌ LANG FORCED ERROR:", e?.message || e);
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

  async function ensureReplyLanguage(
    text: string,
    targetLang: Lang,
    fallbackLang: Lang
  ): Promise<string> {
    const raw = String(text || "").trim();
    if (!raw) return raw;

    try {
      const detected = await detectarIdioma(raw);
      const replyLang = detected.lang;

      // Si no pudimos detectar, no inventamos nada aquí.
      // Dejamos pasar el texto original.
      if (replyLang !== "es" && replyLang !== "en") {
        return raw;
      }

      // Ya está en el idioma correcto
      if (replyLang === targetLang) {
        return raw;
      }

      // Traducir al idioma del turno actual
      return await traducirMensaje(raw, targetLang);
    } catch (e: any) {
      console.warn("⚠️ ensureReplyLanguage failed:", e?.message || e);
      return raw;
    }
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

  // Guarda el ctx original antes de pasar por resolveLangForTurn
  const convoCtxBeforeLang = convoCtx;

  // ===============================
  // 🌍 LANG RESOLUTION (CLIENT-FIRST) – refactorizada
  // ===============================
  console.log("B3 antes resolveLangForTurn");
  const langOut = await resolveLangForTurn({
    pool,
    tenant,
    canal,
    contactoNorm,
    userInput,
    convoCtx,
    tenantBase,
    forcedLangThisTurn,
  });

  console.log("B4 despues resolveLangForTurn");

  idiomaDestino = langOut.idiomaDestino;
  let promptBase = langOut.promptBase;
  let promptBaseMem = langOut.promptBaseMem;
  const storedLang = langOut.storedLang;
  const langRes = langOut.langRes;
  // ❌ ANTES: convoCtx = langOut.convoCtx;
  // ✅ AHORA: hacemos MERGE para no perder cosas como last_catalog_plans
  convoCtx = {
    ...(convoCtxBeforeLang || {}),
    ...(langOut.convoCtx || {}),
  };

  console.log("🌍 LANG DEBUG =", {
    userInput,
    tenantBase,
    storedLang,
    detectedLang: langRes.detectedLang,
    lockedLang: langRes.lockedLang,
    inBookingLang: langRes.inBookingLang,
    idiomaDestino,
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

  // ✅ google_calendar_enabled flag (source of truth)
  let bookingEnabled = false;
  try {
    console.log("A3 antes select channel_settings");

  const { rows } = await queryWithTimeout(
    `SELECT google_calendar_enabled
    FROM channel_settings
    WHERE tenant_id = $1
    LIMIT 1`,
    [tenant.id],
    12000
  );

  console.log("A4 despues select channel_settings");
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
    const finalText = await ensureReplyLanguage(
      text,
      idiomaDestino,
      tenantBase
    );

    setReply(finalText, source, intent);
    await finalizeReply();
    return;
  }

  // ===============================
  // 📅 BOOKING helper (usa módulo genérico)
  // ===============================
  async function tryBooking(mode: "gate" | "guardrail", tag: string) {
    const bookingRes = await handleBookingTurn({
      pool,
      tenantId: tenant.id,
      canal,                 // "whatsapp" aquí, pero genérico para otros canales
      contactoNorm,
      idiomaDestino,
      userInput,
      messageId: messageId || null,

      ctx: convoCtx,

      bookingEnabled,
      promptBase,

      detectedIntent,
      intentFallback: INTENCION_FINAL_CANONICA,

      mode,
      sourceTag: tag,

      transition,

      // cómo se persiste conversation_state en WhatsApp
      persistState: async (nextCtx) => {
        await setConversationStateCompat(tenant.id, canal, contactoNorm, {
          activeFlow,
          activeStep,
          context: nextCtx,
        });
        convoCtx = nextCtx;
      },
    });

    // siempre sincronizamos el contexto local con el que devolvió booking
    convoCtx = bookingRes.ctx;

    if (bookingRes.handled && bookingRes.reply) {
      await replyAndExit(
        bookingRes.reply,
        bookingRes.source || "booking_pipeline",
        bookingRes.intent || null
      );
      return true;
    }

    return false;
  }

  if (await tryBooking("gate", "pre_sm")) return;

  const bookingStep0 = (convoCtx as any)?.booking?.step;
  let inBooking0 = !!(bookingStep0 && bookingStep0 !== "idle");

  const awaiting = (convoCtx as any)?.awaiting || activeStep || null;

  // ===============================
  // 🔎 DEBUG: estado de flujo (clientes)
  // ===============================
  try {
    console.log("A5 antes select clientes state");

    const { rows } = await queryWithTimeout(
      `SELECT estado, human_override, info_explicada, selected_channel
      FROM clientes
      WHERE tenant_id = $1 AND canal = $2 AND contacto = $3
      LIMIT 1`,
      [tenant.id, canal, contactoNorm],
      12000
    );

    console.log("A6 despues select clientes state");

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
  // 🔔 USER SIGNALS (intención, emoción, memoria, override)
  // ===============================
  console.log("B5 antes handleUserSignalsTurn");
  const signals = await handleUserSignalsTurn({
    pool,
    tenant,
    canal,
    contactoNorm,
    fromNumber,
    userInput,
    messageId: messageId || null,
    idiomaDestino,
    promptBase,              // base SIN memoria
    convoCtx,
    INTENCION_FINAL_CANONICA,
    transition,
  });

  console.log("B6 despues handleUserSignalsTurn");

  // ===============================
  // 🧹 RESET estado pago si cambia la intención
  // ===============================
  try {
    if (
      INTENCION_FINAL_CANONICA &&
      INTENCION_FINAL_CANONICA !== "pago"
    ) {
      console.log("A7 antes reset estado pago");

      await queryWithTimeout(
        `UPDATE clientes
        SET estado = NULL
        WHERE tenant_id = $1
        AND canal = $2
        AND contacto = $3
        AND estado = 'esperando_pago'`,
        [tenant.id, canal, contactoNorm],
        12000
      );

      console.log("A8 despues reset estado pago");
    }
  } catch (e: any) {
    console.warn("⚠️ reset estado pago failed:", e?.message);
  }

  // sincronizar variables locales con lo que devolvió el helper
  detectedIntent           = signals.detectedIntent;
  detectedInterest         = signals.detectedInterest;
  INTENCION_FINAL_CANONICA = signals.INTENCION_FINAL_CANONICA;
  promptBaseMem            = signals.promptBaseMem;
  convoCtx = {
    ...(convoCtx || {}),
    ...(signals.convoCtx || {}),
  };

  console.log("🧠 CONVOCTX after signals merge =", {
    last_service_id: (convoCtx as any)?.last_service_id || null,
    last_service_name: (convoCtx as any)?.last_service_name || null,
    selectedServiceId: (convoCtx as any)?.selectedServiceId || null,
    last_catalog_plans: (convoCtx as any)?.last_catalog_plans || null,
  });

  // ===============================
  // ✅ PENDING CTA ACCEPTANCE
  // ===============================
  {
    const normalizedInput = String(userInput || "").trim().toLowerCase();

    const isAffirmative =
      /^(si|sí|si por favor|sí por favor|yes|yes please|ok|okay|dale|claro|sure)$/i.test(normalizedInput);

    const pendingCtaType = String((convoCtx as any)?.pending_cta?.type || "").trim();

    if (pendingCtaType === "estimate_offer" && isAffirmative) {
      console.log("[PENDING_CTA][ACCEPTED]", {
        tenantId: tenant.id,
        canal,
        contactoNorm,
        pendingCtaType,
        userInput,
      });

      (convoCtx as any).pending_cta = null;

      const prevEstimate = (convoCtx as any)?.estimateFlow || {};
      (convoCtx as any).estimateFlow = {
        ...prevEstimate,
        active: true,
        step: prevEstimate.step && prevEstimate.step !== "idle"
          ? prevEstimate.step
          : "start",
      };
    }

    if (pendingCtaType === "booking_offer" && isAffirmative) {
      console.log("[PENDING_CTA][ACCEPTED]", {
        tenantId: tenant.id,
        canal,
        contactoNorm,
        pendingCtaType,
        userInput,
      });

      (convoCtx as any).pending_cta = null;

      const prevBooking = (convoCtx as any)?.booking || {};
      (convoCtx as any).booking = {
        ...prevBooking,
        active: true,
        step: prevBooking.step && prevBooking.step !== "idle"
          ? prevBooking.step
          : "start",
      };
    }
  }

  // ===============================
  // 🎯 Booking vs Info General de Horarios
  // ===============================
  const intentNow = INTENCION_FINAL_CANONICA || detectedIntent || null;

  // Intenciones que consideramos **propias de booking**
  const BOOKING_INTENTS = new Set<string>([
    "booking_start",
    "booking_date",
    "booking_time",
    "booking_confirm",
    "booking_change",
    "booking_horarios",        // horarios ligados a la cita puntual
  ]);

  // Intención para info general de horarios/precios del negocio
  const INFO_HORARIOS_INTENTS = new Set<string>([
    "info_horarios_generales",
  ]);

  if (inBooking0) {
    if (intentNow && INFO_HORARIOS_INTENTS.has(intentNow)) {
      // ✅ El usuario está en booking, pero la intención actual
      // es ver HORARIOS/PRECIOS GENERALES del negocio.
      // Dejamos que el fastpath de catálogo responda.
      console.log("🔓 booking: se permite fastpath para info_horarios_generales", {
        bookingStep0,
        intentNow,
      });
      inBooking0 = false;
    } else if (intentNow && !BOOKING_INTENTS.has(intentNow)) {
      // Si el booking está activo pero la intención ya no es de booking,
      // puedes optar por soltar el lock para que la conversación siga normal.
      console.log("🔓 booking: lock liberado porque intent no es de booking", {
        bookingStep0,
        intentNow,
      });
      inBooking0 = false;

      // Opcional: resetear el flag en contexto
      if ((convoCtx as any)?.booking) {
        (convoCtx as any).booking = {
          ...(convoCtx as any).booking,
          step: "idle",
        };
      }
    }
  }

  // Si el helper ya manejó el turno (p.ej. human override explícito), salimos aquí
  if (signals.handled && signals.humanOverrideReply) {
    return await replyAndExit(
      signals.humanOverrideReply,
      signals.humanOverrideSource || "human_override_explicit",
      detectedIntent
    );
  }

  // ===============================
  // 🏠 ESTIMATE FLOW
  // ===============================
  {
    const estimateResult = await runEstimateFlowTurn({
      pool,
      tenant,
      convoCtx,
      userInput,
      idiomaDestino,
      canal,
      contactoNorm,
    });

    if (estimateResult.handled) {
      transition({
        flow: "estimate_flow",
        step: estimateResult.nextEstimateState.step,
        patchCtx: {
          estimateFlow: estimateResult.nextEstimateState,
          estimate_flow_last_touch_at: Date.now(),
          last_bot_action: "estimate_flow_turn",
          last_reply_source: "estimate_flow",
        },
      });

      return await replyAndExit(
        estimateResult.finalReply,
        "estimate_flow",
        "estimate_flow"
      );
    }
  }

  // ===============================
  // ✅ POST-BOOKING COURTESY GUARD
  // Evita que después de agendar, un "gracias" dispare el saludo inicial.
  // ===============================
  {
    const c = postBookingCourtesyGuard({ ctx: convoCtx, userInput, idioma: idiomaDestino });
    if (c.hit) return await replyAndExit(c.reply, "post_booking_courtesy", "cortesia");
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
  // ⚡ FASTPATH (módulo híbrido reutilizable)
  //    🔒 NO corre si hay booking activo
  // ===============================
  if (!inBooking0) {

    console.log("📦 FASTPATH IN ctx =", {
      last_catalog_plans: (convoCtx as any)?.last_catalog_plans || null,
      last_catalog_at: (convoCtx as any)?.last_catalog_at || null,
      bookingStep0,
    });
    
    console.log("B7 antes handleFastpathHybridTurn");

    const fpRes = await handleFastpathHybridTurn({
      pool,
      tenantId: tenant.id,
      canal,
      idiomaDestino,
      userInput,
      inBooking: Boolean(inBooking0),
      convoCtx,
      infoClave: String(tenant?.info_clave || ""),
      detectedIntent: detectedIntent || null,
      intentFallback: INTENCION_FINAL_CANONICA || null,
      messageId: messageId || null,
      contactoNorm,
      promptBaseMem,
    });

    console.log("B8 despues handleFastpathHybridTurn");

    // aplicar patch de contexto devuelto por el helper
    if (fpRes.ctxPatch) {
      transition({ patchCtx: fpRes.ctxPatch });
    }

    if (fpRes.handled && fpRes.reply) {
      if (fpRes.intent) {
        INTENCION_FINAL_CANONICA = fpRes.intent;
        lastIntent = fpRes.intent;
      }

      console.log("🧠 CONVOCTX after fastpath patch =", {
        last_service_id: (convoCtx as any)?.last_service_id || null,
        last_service_name: (convoCtx as any)?.last_service_name || null,
        selectedServiceId: (convoCtx as any)?.selectedServiceId || null,
        fpIntent: fpRes.intent || null,
        fpSource: fpRes.replySource || null,
      });

      return await replyAndExit(
        fpRes.reply,
        fpRes.replySource || "fastpath_hybrid",
        fpRes.intent || null
      );
    }
  } else {
    console.log("🔒 FASTPATH SKIPPED: booking activo", { bookingStep0 });
  }

  // ===============================
  // 🤖 STATE MACHINE TURN (extraído a helper)
  //    🔒 NO corre si hay booking activo
  // ===============================
  if (!inBooking0) {
    const smHandled = await handleStateMachineTurn({
      pool,
      sm,
      tenant,
      canal,
      contactoNorm,
      userInput,
      messageId: messageId || null,
      idiomaDestino,
      promptBase,       // base SIN memoria
      promptBaseMem,   // base + memoria (si aplica)
      MAX_LINES: MAX_WHATSAPP_LINES,
      tryBooking,
      tenantId: tenant.id,
      eventUserInput: event.userInput,
      replyAndExit,    // callback local que ya usa finalizeReply por debajo
      parseDatosCliente,
      extractPaymentLinkFromPrompt: null,
      PAGO_CONFIRM_REGEX: null,
    });

    if (smHandled) {
      // SM ya respondió (o hizo silencio con log); no seguimos al fallback
      return;
    }
  } else {
    console.log("🔒 SM SKIPPED: booking activo", { bookingStep0 });
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

    const PRICE_LIST_FORMAT_RULE =
      idiomaDestino === "en"
        ? [
            "RULE: If your reply mentions any prices or plans from SYSTEM_STRUCTURED_DATA, you MUST format them as a bullet list.",
            "- You may start with 0–1 very short intro line (e.g. 'Main prices are:').",
            "- Then put ONE option per line like: '• Plan Gold Autopay: $165.99/month – short benefit'.",
            "- NEVER put several different prices or plans in one long paragraph.",
            "- If the user also asks about schedules/hours, answer hours in 1 short sentence and then show the prices as a bullet list."
          ].join(" ")
        : [
            "REGLA: Si tu respuesta menciona precios o planes tomados de DATOS_ESTRUCTURADOS_DEL_SISTEMA, DEBES formatearlos como lista con viñetas.",
            "- Puedes empezar con 0–1 línea muy corta de introducción (por ejemplo: 'Los precios principales son:').",
            "- Luego usa UNA línea por opción, por ejemplo: '• Plan Gold Autopay: $165.99/mes – beneficio breve'.",
            "- NUNCA metas varios precios o planes distintos en un solo párrafo largo.",
            "- Si el usuario también pregunta por horarios, responde los horarios en 1 frase corta y después muestra los precios como lista con viñetas."
          ].join(" ");

    // 🚫 ROLLBACK: PROMPT-ONLY (sin DB catalog)
    const fallbackWelcome = await getBienvenidaPorCanal("whatsapp", tenant, idiomaDestino);

    const structuredService =
      (convoCtx as any)?.structuredService ??
      null;

    const resolvedEntityId =
      structuredService?.serviceId ??
      structuredService?.id ??
      (convoCtx as any)?.last_service_id ??
      (convoCtx as any)?.selectedServiceId ??
      null;

    const resolvedEntityLabel =
      structuredService?.serviceLabel ??
      structuredService?.label ??
      structuredService?.serviceName ??
      (convoCtx as any)?.last_service_name ??
      null;

    const hasResolvedEntity = Boolean(
      resolvedEntityId || resolvedEntityLabel
    );

    console.log("[WHATSAPP][SM_FALLBACK][STRUCTURED_SERVICE]", {
      resolvedEntityId,
      resolvedEntityLabel,
      hasResolvedEntity,
    });

    if (
      (INTENCION_FINAL_CANONICA === "info_servicio" || detectedIntent === "info_servicio") &&
      !hasResolvedEntity
    ) {
      const resolved = await resolveServiceCandidatesFromText(
        pool,
        event.tenantId,
        event.userInput,
        { mode: "loose" }
      );

      if (resolved.ambiguous && resolved.candidates.length >= 2) {
        const MAX_OPTIONS = 3;
        const topCandidates = resolved.candidates.slice(0, MAX_OPTIONS);

        const { rows: serviceRows } = await pool.query<{
          id: string;
          name: string | null;
        }>(
          `
          SELECT s.id, s.name
          FROM services s
          WHERE s.tenant_id = $1
            AND s.id = ANY($2::uuid[])
            AND s.active = true
          ORDER BY s.created_at ASC
          `,
          [event.tenantId, topCandidates.map((c) => c.id)]
        );

        const nameById = new Map(
          serviceRows.map((r) => [String(r.id), String(r.name || "").trim()])
        );

        const options = topCandidates
          .map((c) => nameById.get(String(c.id)) || c.name)
          .filter(Boolean);

        const ambiguityBlock = [
          "AMBIGUOUS_SERVICE_OPTIONS:",
          ...options.map((opt) => `• ${opt}`),
          "",
          "TASK:",
          "Write a short clarification message asking which option the user means.",
          "",
          "RULES:",
          "- Mention the options exactly as written.",
          "- Do not recommend any option.",
          "- Do not explain the services.",
          "- Do not rename the options.",
          "- Maximum 4 lines.",
        ].join("\n");

        async function composeClarification() {
          return await answerWithPromptBase({
            tenantId: event.tenantId,
            promptBase: [
              promptBaseMem,
              "",
              ambiguityBlock,
              "",
              NO_NUMERIC_MENUS,
            ].join("\n"),
            userInput: ["USER_MESSAGE:", event.userInput].join("\n"),
            history,
            idiomaDestino,
            canal: "whatsapp",
            maxLines: 4,
            fallbackText: "",
            responsePolicy: {
              mode: "grounded_only",
              resolvedEntityType: null,
              resolvedEntityId: null,
              resolvedEntityLabel: null,
              canMentionSpecificPrice: false,
              canSelectSpecificCatalogItem: false,
              canOfferBookingTimes: false,
              canUseCatalogLists: true,
              canUseOfficialLinks: false,
              unresolvedEntity: true,
              clarificationTarget: "service",
              reasoningNotes: "whatsapp_ambiguous_service_clarification",
            },
          });
        }

        const try1 = await composeClarification();
        let clarifyText = String(try1.text || "").trim();

        const includesEnoughOptions = (text: string) => {
          const norm = String(text || "").toLowerCase();
          const mentioned = options.filter((opt) =>
            norm.includes(opt.toLowerCase())
          );
          return mentioned.length >= Math.min(2, options.length);
        };

        if (!includesEnoughOptions(clarifyText)) {
          const try2 = await composeClarification();
          clarifyText = String(try2.text || "").trim();
        }

        if (!includesEnoughOptions(clarifyText)) {
          console.log("[WHATSAPP][AMBIGUOUS_SERVICE][LLM_INVALID_AFTER_RETRY]", {
            tenantId: event.tenantId,
            canal: "whatsapp",
            userInput: event.userInput,
            options,
            clarifyText,
          });

          const listOnlyText = options.map((opt) => `• ${opt}`).join("\n");

          const intro =
            clarifyText && clarifyText.length > 0
              ? clarifyText
              : "Te puedo ayudar con estas opciones:";

          const finalText = `${intro}

      ${listOnlyText}

      ¿Cuál de estas opciones buscas?`;

          setReply(
            finalText,
            "sm-fallback-ambiguous-service",
            "info_servicio"
          );
          await finalizeReply();
          return;
        }

        console.log("[WHATSAPP][SM_FALLBACK][AMBIGUOUS_SERVICE -> ASK_CLARIFICATION]", {
          tenantId: event.tenantId,
          canal: "whatsapp",
          userInput: event.userInput,
          options,
          replyPreview: clarifyText.slice(0, 200),
        });

        setReply(
          clarifyText,
          "sm-fallback-ambiguous-service",
          "info_servicio"
        );
        await finalizeReply();
        return;
      }
    }

    let serviceRecommendationBlock = "";
    let validServiceNames: string[] = [];

    if (
      (INTENCION_FINAL_CANONICA === "info_servicio" || detectedIntent === "info_servicio") &&
      !hasResolvedEntity
    ) {
      const { rows: serviceRows } = await pool.query<{
        service_id: string;
        service_name: string | null;
        service_description: string | null;
        variant_name: string | null;
        variant_description: string | null;
      }>(
        `
        SELECT
          s.id AS service_id,
          s.name AS service_name,
          s.description AS service_description,
          v.variant_name,
          v.description AS variant_description
        FROM services s
        LEFT JOIN service_variants v
          ON v.service_id = s.id
         AND v.active = true
        WHERE
          s.tenant_id = $1
          AND s.active = true
          AND s.name IS NOT NULL
        ORDER BY s.created_at ASC, v.created_at ASC NULLS LAST, v.id ASC NULLS LAST
        `,
        [event.tenantId]
      );

      const grouped = new Map<
        string,
        {
          id: string;
          name: string;
          snippets: string[];
        }
      >();

      for (const r of serviceRows) {
        const id = String(r.service_id || "").trim();
        const name = String(r.service_name || "").trim();
        if (!id || !name) continue;

        let entry = grouped.get(id);
        if (!entry) {
          entry = { id, name, snippets: [] };
          grouped.set(id, entry);
        }

        const parts = [
          String(r.service_description || "").trim(),
          String(r.variant_name || "").trim(),
          String(r.variant_description || "").trim(),
        ].filter(Boolean);

        for (const p of parts) {
          if (!entry.snippets.includes(p)) entry.snippets.push(p);
        }
      }

      const serviceCandidates = Array.from(grouped.values()).slice(0, 8);
      validServiceNames = serviceCandidates.map((s) => s.name);

      serviceRecommendationBlock =
        idiomaDestino === "en"
          ? [
              "SYSTEM_STRUCTURED_SERVICE_CANDIDATES:",
              ...serviceCandidates.map((s, idx) => {
                const extra = s.snippets.slice(0, 2).join(" | ");
                return `${idx + 1}. ${s.name}${extra ? ` — ${extra}` : ""}`;
              }),
              "",
              "STRICT RULES:",
              "- If you recommend a service, recommend ONLY one service name that appears EXACTLY in the candidate list above.",
              "- Never invent, translate, merge, generalize, or rename service names.",
              "- If none is clearly appropriate, ask ONE short clarification question instead.",
            ].join("\n")
          : [
              "CANDIDATOS_DE_SERVICIO_ESTRUCTURADOS_DEL_SISTEMA:",
              ...serviceCandidates.map((s, idx) => {
                const extra = s.snippets.slice(0, 2).join(" | ");
                return `${idx + 1}. ${s.name}${extra ? ` — ${extra}` : ""}`;
              }),
              "",
              "REGLAS ESTRICTAS:",
              "- Si recomiendas un servicio, recomienda SOLO un nombre de servicio que aparezca EXACTAMENTE en la lista anterior.",
              "- Nunca inventes, traduzcas, mezcles, generalices ni renombres servicios.",
              "- Si ninguno encaja claramente, haz UNA sola pregunta corta de aclaración.",
            ].join("\n");

      console.log("[WHATSAPP][SM_FALLBACK][DB_SERVICE_CANDIDATES_FOR_LLM]", {
        tenantId: event.tenantId,
        canal: "whatsapp",
        userInput: event.userInput,
        validServiceNames,
      });
    }

    const composed = await answerWithPromptBase({
      tenantId: event.tenantId,
      promptBase: [
        promptBaseMem,
        "",
        serviceRecommendationBlock,
        "",
        NO_NUMERIC_MENUS,
        PRICE_QUALIFIER_RULE,
        NO_PRICE_INVENTION_RULE,
        PRICE_LIST_FORMAT_RULE,
      ].join("\n"),
      userInput: ["USER_MESSAGE:", event.userInput].join("\n"),
      history,
      idiomaDestino,
      canal: "whatsapp",
      maxLines: MAX_WHATSAPP_LINES,
      fallbackText: fallbackWelcome,

      responsePolicy: {
        mode: hasResolvedEntity ? "grounded_only" : "clarify_only",
        resolvedEntityType: hasResolvedEntity ? "service" : null,
        resolvedEntityId,
        resolvedEntityLabel,
        canMentionSpecificPrice: hasResolvedEntity,
        canSelectSpecificCatalogItem: hasResolvedEntity,
        canOfferBookingTimes: false,
        canUseCatalogLists: hasResolvedEntity,
        canUseOfficialLinks: true,
        unresolvedEntity: !hasResolvedEntity,
        clarificationTarget: hasResolvedEntity ? null : "service",
        reasoningNotes: "whatsapp_sm_fallback",
      },
    });

    if (validServiceNames.length > 0) {
      const normalizedReply = String(composed.text || "").toLowerCase();

      const matchedValidName = validServiceNames.find((name) =>
        normalizedReply.includes(name.toLowerCase())
      );

      if (!matchedValidName) {
        const clarificationText =
          idiomaDestino === "en"
            ? `Sure — what service do you mean exactly? For example: ${validServiceNames.slice(0, 4).join(", ")}.`
            : `Claro — ¿a cuál servicio te refieres exactamente? Por ejemplo: ${validServiceNames.slice(0, 4).join(", ")}.`;

        console.log("[WHATSAPP][SM_FALLBACK][INVALID_SERVICE_RECOMMENDATION_BLOCKED]", {
          tenantId: event.tenantId,
          canal: "whatsapp",
          userInput: event.userInput,
          replyPreview: String(composed.text || "").slice(0, 200),
          validServiceNames,
        });

        setReply(clarificationText, "sm-fallback-invalid-service", "info_servicio");
        await finalizeReply();
        return;
      }
    }

    if (composed.pendingCta) {
      (convoCtx as any).pending_cta = {
        ...composed.pendingCta,
        createdAt: new Date().toISOString(),
      };

      console.log("[PENDING_CTA][SET][sm-fallback]", {
        tenantId: event.tenantId,
        contacto: contactoNorm,
        canal: "whatsapp",
        pendingCta: (convoCtx as any).pending_cta,
        replyPreview: composed.text.slice(0, 200),
      });
    }

    const finalFallbackText = await ensureReplyLanguage(
      composed.text,
      idiomaDestino,
      tenantBase
    );

    setReply(finalFallbackText, "sm-fallback");
    await finalizeReply();
    return;
  }
}