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
import { stripMarkdownLinksForDm } from "../../lib/channels/format/stripMarkdownLinks";

import { buildCatalogReferenceClassificationInput } from "../../lib/catalog/buildCatalogReferenceClassificationInput";
import { classifyCatalogReferenceTurn } from "../../lib/catalog/classifyCatalogReferenceTurn";

import { isBusinessGeneralIntent } from "../../lib/channels/engine/intents/isBusinessGeneralIntent";

import { resolveBusinessOverview } from "../../lib/business/resolveBusinessOverview";

// Puedes ponerlo debajo de los imports
export type WhatsAppContext = {
  tenant?: any;
  canal?: string;
  origen?: "twilio" | "meta";
};

const MAX_WHATSAPP_LINES = 9999; // 14–16 es el sweet spot

type IntentFacets = {
  asksPrices?: boolean;
  asksSchedules?: boolean;
  asksLocation?: boolean;
  asksAvailability?: boolean;
};

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
  let detectedFacets: IntentFacets | null = null;

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
  let forcedLangThisTurn: Lang | null = null;

  const normalizeChoice = (s: string) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const origen = turn.origen;

  const numero = turn.numero;
  const numeroSinMas = turn.numeroSinMas;

  const fromNumber = turn.fromNumber;
  const contactoNorm = turn.contactoNorm;

  if (messageId) {

  const r = await queryWithTimeout(
    `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (tenant_id, canal, message_id) DO NOTHING
    RETURNING 1`,
    [tenant.id, canal, messageId],
    12000
  );

    if (r.rowCount === 0) {
      console.log("⏩ inbound dedupe: ya procesado messageId", messageId);
      return;
    }
  }

  const isNewLead = await ensureClienteBase(pool, tenant.id, canal, contactoNorm);

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

  // ✅ FOLLOW-UP RESET: si el cliente volvió a escribir, cancela cualquier follow-up pendiente
  try {
    const deleted = await cancelPendingFollowUps({
      tenantId: tenant.id,
      canal: canal as any,         // 'whatsapp'
      contacto: contactoNorm,
    });

    if (deleted > 0) {
      
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

  // ===============================
  // 🛡️ GATE ANTI-DUPLICADOS (texto + contacto + tenant)
  // ✅ contextual: no bloquea picks cortos entre pasos distintos
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

      // respuestas cortas reutilizables en flujos distintos:
      // 1, 2, si, ok, por mes, autopago, etc.
      const tokenCount = normText.split(/\s+/).filter(Boolean).length;

      const isReusableShortReply =
        /^[1-9]$/.test(normText) ||
        tokenCount <= 2;

      // fingerprint del paso actual para no confundir:
      // "1" en elegir plan != "1" en elegir variante != "1" en elegir link
      const dedupeStepFingerprint = [
        String(activeFlow || ""),
        String(activeStep || ""),
        String((convoCtx as any)?.last_bot_action || ""),
        Boolean((convoCtx as any)?.pending_link_lookup) ? "pending_link" : "",
        Boolean((convoCtx as any)?.expectingVariant) ? "expecting_variant" : "",
        String((convoCtx as any)?.selectedServiceId || ""),
        String((convoCtx as any)?.last_service_id || ""),
        String((convoCtx as any)?.last_variant_id || ""),
        String((convoCtx as any)?.last_selected_id || ""),
      ]
        .filter(Boolean)
        .join("|");

      const key = isReusableShortReply
        ? `${tenant.id}:${canal}:${contactKey}:${normText}:${dedupeStepFingerprint}`
        : `${tenant.id}:${canal}:${contactKey}:${normText}`;

      const now = Date.now();
      const ttlMs = 15_000; // ventana de 15s para evitar reintentos reales

      const last = inboundDedupCache.get(key);

      if (typeof last === "number" && now - last >= 0 && now - last < ttlMs) {
        console.log("🚫 inbound dedupe: mensaje duplicado reciente, se omite procesamiento", {
          key,
          diffMs: now - last,
          isReusableShortReply,
          dedupeStepFingerprint,
        });
        return;
      }

      inboundDedupCache.set(key, now);
    }
  }

  // Guarda el ctx original antes de pasar por resolveLangForTurn
  const convoCtxBeforeLang = convoCtx;

  // ===============================
  // 🌍 LANG RESOLUTION (CLIENT-FIRST) – refactorizada
  // ===============================
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

  const { rows } = await queryWithTimeout(
    `SELECT google_calendar_enabled
    FROM channel_settings
    WHERE tenant_id = $1
    LIMIT 1`,
    [tenant.id],
    12000
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

    const { rows } = await queryWithTimeout(
      `SELECT estado, human_override, info_explicada, selected_channel
      FROM clientes
      WHERE tenant_id = $1 AND canal = $2 AND contacto = $3
      LIMIT 1`,
      [tenant.id, canal, contactoNorm],
      12000
    );

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

  // ===============================
  // 🧹 RESET estado pago si cambia la intención
  // ===============================
  try {
    if (
      INTENCION_FINAL_CANONICA &&
      INTENCION_FINAL_CANONICA !== "pago"
    ) {

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

    }
  } catch (e: any) {
    console.warn("⚠️ reset estado pago failed:", e?.message);
  }

  // sincronizar variables locales con lo que devolvió el helper
  detectedIntent           = signals.detectedIntent;
  detectedInterest         = signals.detectedInterest;
  detectedFacets           = (signals as any).detectedFacets || (signals as any).facets || null;
  INTENCION_FINAL_CANONICA = signals.INTENCION_FINAL_CANONICA;
  promptBaseMem            = signals.promptBaseMem;
  convoCtx = {
    ...(convoCtx || {}),
    ...(signals.convoCtx || {}),
  };

  const whatsappCatalogReferenceClassificationInput =
    buildCatalogReferenceClassificationInput({
      userText: event.userInput,
      convoCtx,
    });

  const whatsappCatalogReferenceClassification =
    classifyCatalogReferenceTurn({
      ...whatsappCatalogReferenceClassificationInput,
      detectedIntent: detectedIntent || INTENCION_FINAL_CANONICA || null,
    });

  console.log("[WHATSAPP][CATALOG_REFERENCE_CLASSIFIER]", {
    tenantId: event.tenantId,
    canal: "whatsapp",
    contactoNorm,
    userInput: event.userInput,
    classificationInput: whatsappCatalogReferenceClassificationInput,
    classification: whatsappCatalogReferenceClassification,
  });

  // ===============================
  // 🧹 RESET de selección vieja si entra una intención nueva clara
  // SIN usar detectedInterest ni regex de vertical
  // ===============================
  {
    const intentNow = INTENCION_FINAL_CANONICA || detectedIntent || null;

    const hasStaleSelectionContext =
      Boolean((convoCtx as any)?.expectingVariant) ||
      Boolean((convoCtx as any)?.selectedServiceId) ||
      Boolean((convoCtx as any)?.last_plan_list?.length) ||
      Boolean((convoCtx as any)?.last_package_list?.length) ||
      Boolean((convoCtx as any)?.pending_link_lookup) ||
      Boolean((convoCtx as any)?.last_service_id) ||
      Boolean((convoCtx as any)?.structuredService);

    const NEW_INTENT_RESET_SET = new Set<string>([
      "agendar",
      "booking_start",
      "info_servicio",
      "precio",
      "planes_precios",
    ]);

    const normalizedInput = String(userInput || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();

    const hasActiveSelectionContext =
      Boolean((convoCtx as any)?.pending_link_lookup) ||
      Boolean((convoCtx as any)?.pending_price_lookup) ||
      Boolean((convoCtx as any)?.expectingVariant) ||
      (Array.isArray((convoCtx as any)?.pending_link_options) &&
        (convoCtx as any).pending_link_options.length > 0) ||
      (Array.isArray((convoCtx as any)?.last_plan_list) &&
        (convoCtx as any).last_plan_list.length > 0);

    const isShortFreeText =
      typeof userInput === "string" &&
      userInput.trim().length > 0 &&
      userInput.trim().length <= 20;

    const hasQuestionMark = /[?¿]/.test(userInput);

    const isClearlyLongSentence =
      userInput.trim().split(/\s+/).length >= 5;

    const looksLikeSelectionReply =
      /^[1-9]$/.test(normalizedInput) ||
      (
        hasActiveSelectionContext &&
        isShortFreeText &&
        !hasQuestionMark &&
        !isClearlyLongSentence
      );

    if (
      intentNow &&
      NEW_INTENT_RESET_SET.has(intentNow) &&
      hasStaleSelectionContext &&
      !looksLikeSelectionReply
    ) {
      (convoCtx as any).expectingVariant = false;
      (convoCtx as any).selectedServiceId = null;

      (convoCtx as any).last_plan_list = null;
      (convoCtx as any).last_plan_list_at = null;

      (convoCtx as any).last_package_list = null;
      (convoCtx as any).last_package_list_at = null;

      (convoCtx as any).last_list_kind = null;
      (convoCtx as any).last_list_kind_at = null;

      (convoCtx as any).pending_link_lookup = null;
      (convoCtx as any).pending_link_at = null;
      (convoCtx as any).pending_link_options = null;

      (convoCtx as any).last_service_id = null;
      (convoCtx as any).last_service_name = null;
      (convoCtx as any).last_service_label = null;

      (convoCtx as any).last_entity_kind = null;
      (convoCtx as any).last_entity_at = null;

      (convoCtx as any).structuredService = null;
    }
  }

  // ===============================
  // ✅ PENDING CTA ACCEPTANCE
  // ===============================
  {
    const normalizedInput = String(userInput || "").trim().toLowerCase();

    const isAffirmative =
      /^(si|sí|si por favor|sí por favor|yes|yes please|ok|okay|dale|claro|sure)$/i.test(normalizedInput);

    const pendingCtaType = String((convoCtx as any)?.pending_cta?.type || "").trim();

    if (pendingCtaType === "estimate_offer" && isAffirmative) {
      
      (convoCtx as any).pending_cta = null;

      // ✅ limpiar contexto de selección anterior para que no contamine
      (convoCtx as any).expectingVariant = false;
      (convoCtx as any).selectedServiceId = null;

      (convoCtx as any).last_variant_id = null;
      (convoCtx as any).last_variant_name = null;
      (convoCtx as any).last_variant_url = null;
      (convoCtx as any).last_variant_at = null;

      (convoCtx as any).last_price_option_label = null;
      (convoCtx as any).last_price_option_at = null;

      (convoCtx as any).last_bot_action = "estimate_cta_accepted";
      (convoCtx as any).last_bot_action_at = Date.now();

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
      
      (convoCtx as any).pending_cta = null;

      // ✅ limpiar contexto de selección anterior para que no contamine
      (convoCtx as any).expectingVariant = false;
      (convoCtx as any).selectedServiceId = null;

      (convoCtx as any).last_variant_id = null;
      (convoCtx as any).last_variant_name = null;
      (convoCtx as any).last_variant_url = null;
      (convoCtx as any).last_variant_at = null;

      (convoCtx as any).last_price_option_label = null;
      (convoCtx as any).last_price_option_at = null;

      (convoCtx as any).last_bot_action = "booking_cta_accepted";
      (convoCtx as any).last_bot_action_at = Date.now();

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
    const convoCtxForFastpath = {
      ...(convoCtx || {}),
      ...((signals as any)?.convoCtx || {}),
    };

    const fpRes = await handleFastpathHybridTurn({
      pool,
      tenantId: tenant.id,
      canal,
      idiomaDestino,
      userInput,
      inBooking: Boolean(inBooking0),
      convoCtx: convoCtxForFastpath,
      infoClave: String(tenant?.info_clave || ""),
      detectedIntent: signals?.detectedIntent || detectedIntent || null,
      detectedFacets:
        (signals as any)?.detectedFacets ||
        (signals as any)?.facets ||
        detectedFacets ||
        {},
      intentFallback:
        signals?.INTENCION_FINAL_CANONICA || INTENCION_FINAL_CANONICA || null,
      messageId: messageId || null,
      contactoNorm,
      promptBaseMem: signals?.promptBaseMem || promptBaseMem,
      referentialFollowup: signals?.referentialFollowup === true,
      followupNeedsAnchor: signals?.followupNeedsAnchor === true,
      followupEntityKind: signals?.followupEntityKind || null,
    });

    // aplicar patch de contexto devuelto por el helper
    if (fpRes.ctxPatch) {
      transition({ patchCtx: fpRes.ctxPatch });
    }

    if (fpRes.handled && fpRes.reply) {
      if (fpRes.intent) {
        INTENCION_FINAL_CANONICA = fpRes.intent;
        lastIntent = fpRes.intent;
      }

      const isStructuredNumericSelection =
        /^[1-9]$/.test(String(userInput || "").trim()) &&
        (
          Boolean((convoCtxForFastpath as any)?.expectingVariant) ||
          Boolean((fpRes.ctxPatch as any)?.expectingVariant) ||
          Boolean((fpRes.ctxPatch as any)?.last_variant_id) ||
          Boolean((fpRes.ctxPatch as any)?.last_variant_name) ||
          Boolean((convoCtxForFastpath as any)?.selectedServiceId) ||
          Boolean((fpRes.ctxPatch as any)?.selectedServiceId)
        );

      if (isStructuredNumericSelection) {
        detectedInterest = Math.max(Number(detectedInterest || 1), 2);

        if (!INTENCION_FINAL_CANONICA || INTENCION_FINAL_CANONICA === "duda") {
          INTENCION_FINAL_CANONICA = fpRes.intent || "info_servicio";
        }

        if (!lastIntent || lastIntent === "duda") {
          lastIntent = fpRes.intent || "info_servicio";
        }
      }

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
    const catalogReferenceKind =
      whatsappCatalogReferenceClassification?.kind ?? "none";

    const shouldBlockConcreteServiceFallback =
      catalogReferenceKind === "catalog_overview" ||
      catalogReferenceKind === "catalog_family";

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

    const clarificationTarget =
      catalogReferenceKind === "catalog_family"
        ? "family"
        : hasResolvedEntity
        ? null
        : "service";

    if (shouldBlockConcreteServiceFallback && !hasResolvedEntity) {
      
    }

    if (
      (INTENCION_FINAL_CANONICA === "info_servicio" || detectedIntent === "info_servicio") &&
      !hasResolvedEntity &&
      !shouldBlockConcreteServiceFallback
    ) {
      const resolved = await resolveServiceCandidatesFromText(
        pool,
        event.tenantId,
        event.userInput,
        { mode: "loose" }
      );

      if (resolved.ambiguous && resolved.candidates.length >= 2) {
        const MAX_OPTIONS = 2;
        const topCandidates = resolved.candidates.slice(0, MAX_OPTIONS);

        const candidateIds = topCandidates
          .map((c) => String(c.id))
          .filter(Boolean);

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
          [event.tenantId, candidateIds]
        );

        const nameById = new Map(
          serviceRows.map((r) => [String(r.id), String(r.name || "").trim()])
        );

        const options = topCandidates
          .map((c) => {
            const dbName = nameById.get(String(c.id));
            const fallbackName = String(c.name || "").trim();
            return dbName || fallbackName || "";
          })
          .map((v) => v.trim())
          .filter((v) => v.length > 0)
          .slice(0, MAX_OPTIONS);

        // ===============================
        // 0 OPCIONES REALES
        // Este branch ya no aplica. Dejamos seguir el pipeline normal.
        // IMPORTANTE: no hacer finalizeReply aquí.
        // ===============================
        if (options.length === 0) {
          
        } else if (options.length === 1) {
          // ===============================
          // 1 OPCIÓN REAL
          // Ya no hay ambigüedad real, así que no preguntamos.
          // ===============================
          let introText =
            idiomaDestino === "en"
              ? "I found the closest option for what you're looking for."
              : "Encontré la opción más cercana a lo que estás buscando.";

          try {
            const introPrompt =
              idiomaDestino === "en"
                ? [
                    "TASK:",
                    "Write ONE short, warm, human WhatsApp sentence presenting a single matching service option.",
                    "",
                    "CONTEXT:",
                    "- The user's request matched one valid service after ambiguity collapse.",
                    "- The service name will be shown immediately after this sentence.",
                    "",
                    "RULES:",
                    "- Do NOT mention prices.",
                    "- Do NOT recommend booking.",
                    "- Do NOT ask a question.",
                    "- Do NOT mention links, appointments, or schedules.",
                    "- Do NOT mention any business vertical or industry.",
                    "- Maximum 1 sentence.",
                    "- Sound natural and confident.",
                  ].join("\n")
                : [
                    "TAREA:",
                    "Escribe UNA sola frase corta, cálida y humana para WhatsApp presentando una única opción de servicio válida.",
                    "",
                    "CONTEXTO:",
                    "- La solicitud del usuario coincidió con una sola opción válida después del colapso de ambigüedad.",
                    "- El nombre del servicio se mostrará justo después de esta frase.",
                    "",
                    "REGLAS:",
                    "- No menciones precios.",
                    "- No recomiendes reservar.",
                    "- No hagas una pregunta.",
                    "- No menciones links, citas ni horarios.",
                    "- No menciones ningún vertical o industria.",
                    "- Máximo 1 frase.",
                    "- Debe sonar natural y segura.",
                  ].join("\n");

            const introRes = await answerWithPromptBase({
              tenantId: event.tenantId,
              promptBase: [promptBaseMem, "", introPrompt, "", NO_NUMERIC_MENUS].join("\n"),
              userInput: [
                "USER_MESSAGE:",
                event.userInput,
                "",
                "MATCHED_OPTION:",
                `- ${options[0]}`,
              ].join("\n"),
              history,
              idiomaDestino,
              canal: "whatsapp",
              maxLines: 1,
              fallbackText: introText,
              responsePolicy: {
                mode: "clarify_only",
                resolvedEntityType: null,
                resolvedEntityId: null,
                resolvedEntityLabel: null,
                canMentionSpecificPrice: false,
                canSelectSpecificCatalogItem: false,
                canOfferBookingTimes: false,
                canUseCatalogLists: false,
                canUseOfficialLinks: false,
                unresolvedEntity: true,
                clarificationTarget: "service",
                reasoningNotes:
                  "whatsapp_single_service_after_ambiguity_collapse",
              },
            });

            const candidateIntro = String(introRes.text || "").trim();

            const normalizedIntro = String(candidateIntro || "").trim();

            const introLooksValid =
              normalizedIntro.length > 0 &&
              normalizedIntro.length <= 160 &&
              !normalizedIntro.includes("?") &&
              !normalizedIntro.includes("\n") &&
              !normalizedIntro.startsWith("•") &&
              !normalizedIntro.startsWith("-") &&
              !options.some((opt) => normalizedIntro.includes(opt)) &&
              (/[.!…]$/.test(normalizedIntro) || normalizedIntro.split(/\s+/).length <= 20);

            if (introLooksValid) {
              introText = candidateIntro;
            }
          } catch (err) {
            
          }

          const finalText = [introText, "", `• ${options[0]}`].join("\n");

          setReply(
            finalText,
            "sm-fallback-single-service-after-ambiguity-collapse",
            "info_servicio"
          );
          await finalizeReply();
          return;
        } else {
          // ===============================
          // 2+ OPCIONES REALES
          // Ahora sí hay ambigüedad real y pedimos aclaración.
          // ===============================
          let introText =
            idiomaDestino === "en"
              ? "I found a couple of options that match what you're looking for."
              : "Encontré un par de opciones que encajan con lo que estás buscando.";

          try {
            const introPrompt =
              idiomaDestino === "en"
                ? [
                    "TASK:",
                    "Write ONE short, warm, human WhatsApp sentence to introduce a small set of service options.",
                    "",
                    "CONTEXT:",
                    "- The user's request matched multiple possible services from the tenant catalog.",
                    "- We will show the options immediately after this sentence.",
                    "",
                    "RULES:",
                    "- Do NOT mention any specific industry or business type.",
                    "- Do NOT mention prices.",
                    "- Do NOT recommend one option over another.",
                    "- Do NOT ask a question.",
                    "- Do NOT mention booking, appointments, links, or schedules.",
                    "- Maximum 1 sentence.",
                    "- Sound natural, warm, and neutral.",
                  ].join("\n")
                : [
                    "TAREA:",
                    "Escribe UNA sola frase corta, cálida y humana para WhatsApp que introduzca un pequeño grupo de opciones de servicio.",
                    "",
                    "CONTEXTO:",
                    "- La solicitud del usuario coincidió con varios servicios posibles del catálogo del tenant.",
                    "- Justo después de esta frase se mostrarán las opciones.",
                    "",
                    "REGLAS:",
                    "- NO menciones ninguna industria ni tipo de negocio.",
                    "- NO menciones precios.",
                    "- NO recomiendes una opción sobre otra.",
                    "- NO hagas una pregunta.",
                    "- NO menciones reservas, citas, links ni horarios.",
                    "- Máximo 1 frase.",
                    "- Debe sonar natural, amable y neutral.",
                  ].join("\n");

            const introRes = await answerWithPromptBase({
              tenantId: event.tenantId,
              promptBase: [promptBaseMem, "", introPrompt, "", NO_NUMERIC_MENUS].join("\n"),
              userInput: [
                "USER_MESSAGE:",
                event.userInput,
                "",
                "CANDIDATE_OPTIONS:",
                options.map((o) => `- ${o}`).join("\n"),
              ].join("\n"),
              history,
              idiomaDestino,
              canal: "whatsapp",
              maxLines: 1,
              fallbackText: introText,
              responsePolicy: {
                mode: "clarify_only",
                resolvedEntityType: null,
                resolvedEntityId: null,
                resolvedEntityLabel: null,
                canMentionSpecificPrice: false,
                canSelectSpecificCatalogItem: false,
                canOfferBookingTimes: false,
                canUseCatalogLists: false,
                canUseOfficialLinks: false,
                unresolvedEntity: true,
                clarificationTarget: "service",
                reasoningNotes: "whatsapp_ambiguous_service_intro_only_multitenant",
              },
            });

            const candidateIntro = String(introRes.text || "").trim();

            const normalizedIntro = String(candidateIntro || "").trim();

            const introLooksValid =
              normalizedIntro.length > 0 &&
              normalizedIntro.length <= 160 &&
              !normalizedIntro.includes("?") &&
              !normalizedIntro.includes("\n") &&
              !normalizedIntro.startsWith("•") &&
              !normalizedIntro.startsWith("-") &&
              !options.some((opt) => normalizedIntro.includes(opt)) &&
              (/[.!…]$/.test(normalizedIntro) || normalizedIntro.split(/\s+/).length <= 20);

            if (introLooksValid) {
              introText = candidateIntro;
            }
          } catch (err) {
            
          }

          const listOnlyText = options.map((opt) => `• ${opt}`).join("\n");

          const closingText =
            idiomaDestino === "en"
              ? "Which of these options are you looking for??"
              : "¿Cuál de estas opciones buscas?";

          const finalText = [introText, "", listOnlyText, "", closingText].join("\n");

          setReply(
            finalText,
            "sm-fallback-ambiguous-service",
            "info_servicio"
          );
          await finalizeReply();
          return;
        }
      }
    }

    let serviceRecommendationBlock = "";
    let validServiceNames: string[] = [];

    const nonConcreteClarificationBlock =
      shouldBlockConcreteServiceFallback &&
      (INTENCION_FINAL_CANONICA === "info_servicio" || detectedIntent === "info_servicio") &&
      !hasResolvedEntity
        ? catalogReferenceKind === "catalog_family"
          ? idiomaDestino === "en"
            ? [
                "STRICT TURN RULES:",
                "- Do NOT recommend or assume one specific service.",
                "- Do NOT select a concrete catalog item.",
                "- Ask ONE short clarification question only.",
                "- The clarification must narrow the user's need within a family/group of services.",
                "- Prefer clarifying the type of result they want, not naming a service for them.",
                "- Do NOT use numbered menus.",
                "- Do NOT ask more than one question.",
              ].join("\n")
            : [
                "REGLAS ESTRICTAS DEL TURNO:",
                "- No recomiendes ni asumas un servicio específico.",
                "- No selecciones un ítem concreto del catálogo.",
                "- Haz UNA sola pregunta corta de aclaración.",
                "- La aclaración debe precisar la necesidad del usuario dentro de una familia o grupo de servicios.",
                "- Prefiere aclarar el resultado que busca, no nombrarle tú un servicio concreto.",
                "- No uses menús numerados.",
                "- No hagas más de una pregunta.",
              ].join("\n")
          : idiomaDestino === "en"
          ? [
              "STRICT TURN RULES:",
              "- Do NOT recommend or assume one specific service.",
              "- Do NOT select a concrete catalog item.",
              "- Do NOT mention a specific service name unless the user clearly selected one before.",
              "- Ask ONE short clarification question only.",
              "- The clarification must help narrow the user's need, not force a booking.",
              "- Do NOT use numbered menus.",
            ].join("\n")
          : [
              "REGLAS ESTRICTAS DEL TURNO:",
              "- No recomiendes ni asumas un servicio específico.",
              "- No selecciones un ítem concreto del catálogo.",
              "- No menciones un nombre de servicio específico a menos que el usuario ya lo haya elegido claramente antes.",
              "- Haz UNA sola pregunta corta de aclaración.",
              "- La aclaración debe ayudar a precisar la necesidad del usuario, no forzar una reserva.",
              "- No uses menús numerados.",
            ].join("\n")
        : "";

    if (
      (INTENCION_FINAL_CANONICA === "info_servicio" || detectedIntent === "info_servicio") &&
      !hasResolvedEntity &&
      !shouldBlockConcreteServiceFallback
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

    }

    const composed = await answerWithPromptBase({
      tenantId: event.tenantId,
      promptBase: [
        promptBaseMem,
        "",
        serviceRecommendationBlock,
        "",
        nonConcreteClarificationBlock,
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
        clarificationTarget: hasResolvedEntity ? null : clarificationTarget,

        singleResolvedEntityOnly: hasResolvedEntity,
        allowAlternativeEntities: false,
        allowCrossSellEntities: false,
        allowAddOnSuggestions: false,

        reasoningNotes: "whatsapp_sm_fallback",
      },
    });

    const normalizedReply = String(composed.text || "").toLowerCase();

    const shouldBypassEntityLockForGeneralIntent = isBusinessGeneralIntent({
      detectedIntent,
      canal: "whatsapp",
    });

    if (!shouldBypassEntityLockForGeneralIntent && hasResolvedEntity && resolvedEntityLabel) {
      const resolvedNameNorm = String(resolvedEntityLabel).toLowerCase();
      const mentionsResolvedEntity = normalizedReply.includes(resolvedNameNorm);

      const mentionsOtherValidService =
        validServiceNames.length > 0 &&
        validServiceNames.some((name) => {
          const n = String(name || "").toLowerCase();
          return n !== resolvedNameNorm && normalizedReply.includes(n);
        });

      if (!mentionsResolvedEntity || mentionsOtherValidService) {
        
        const clarificationText =
          idiomaDestino === "en"
            ? `I recommend ${resolvedEntityLabel}. I can also tell you the price or what it includes.`
            : `Te recomiendo ${resolvedEntityLabel}. También te puedo decir el precio o lo que incluye.`;

        setReply(clarificationText, "sm-fallback-entity-lock-blocked", "info_servicio");
        await finalizeReply();
        return;
      }
    } else if (shouldBypassEntityLockForGeneralIntent) {
      
    } else if (validServiceNames.length > 0) {
      const matchedValidName = validServiceNames.find((name) =>
        normalizedReply.includes(name.toLowerCase())
      );

      if (!matchedValidName) {
        const clarificationText =
          idiomaDestino === "en"
            ? `Sure — what service do you mean exactly? For example: ${validServiceNames.slice(0, 4).join(", ")}.`
            : `Claro — ¿a cuál servicio te refieres exactamente? Por ejemplo: ${validServiceNames.slice(0, 4).join(", ")}.`;

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

    }

    const finalFallbackText = await ensureReplyLanguage(
      composed.text,
      idiomaDestino,
      tenantBase
    );

    const finalFallbackTextClean = stripMarkdownLinksForDm(finalFallbackText);

    // ✅ overview general de servicios desde info_clave,
    // pero dejando ancla estructurada para follow-ups de catálogo/DB
    if (
      (INTENCION_FINAL_CANONICA === "info_general" || detectedIntent === "info_general") &&
      !hasResolvedEntity
    ) {
      try {
        const overview = await resolveBusinessOverview({
          pool,
          tenantId: tenant.id,
          infoClave: String(tenant?.info_clave || ""),
        });

        transition({
          patchCtx: {
            last_catalog_source: overview.source,
            last_catalog_scope: "overview",
            last_catalog_at: Date.now(),
            lastPresentedEntityIds: overview.presentedEntityIds,
            lastPresentedFamilyKeys: overview.presentedFamilyKeys,
            lastResolvedIntent: "info_general",
          },
        });
      } catch (e: any) {
        console.warn("⚠️ resolveBusinessOverview failed:", e?.message || e);
      }
    }

    setReply(finalFallbackTextClean, "sm-fallback");
    await finalizeReply();
    return;
  }
}