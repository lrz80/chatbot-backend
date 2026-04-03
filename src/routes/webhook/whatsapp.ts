// backend/src/routes/webhook/whatsapp.ts

import { Router, Request, Response } from 'express';
import pool from '../../lib/db';
import twilio from 'twilio';

import { detectarIdioma } from '../../lib/detectarIdioma';
import { enviarWhatsApp } from "../../lib/senders/whatsapp";
import type { Canal } from '../../lib/detectarIntencion';
import { antiPhishingGuard } from "../../lib/security/antiPhishing";
import { saludoPuroRegex } from '../../lib/saludosConversacionales';

import { incrementarUsoPorCanal } from '../../lib/incrementUsage';
import { getBienvenidaPorCanal } from '../../lib/getPromptPorCanal';

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

  // ✅ OPTION 1 (Single Exit): una sola salida para enviar/guardar/memoria
  let handled = false;
  let reply: string | null = null;
  let replySource: string | null = null;
  let lastIntent: string | null = null;
  let INTENCION_FINAL_CANONICA: string | null = null;
  let finalCtxPatch: any = {};

  // 🎯 Intent detection (evento)
  let detectedIntent: string | null = null;
  let detectedInterest: number | null = null;
  let detectedFacets: IntentFacets | null = null;

  let replied = false;

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

  function hasPendingCtaAwaitingConfirmation(ctx: any): boolean {
    return Boolean(
      ctx &&
        typeof ctx === "object" &&
        ctx.pending_cta &&
        typeof ctx.pending_cta === "object" &&
        ctx.pending_cta.type &&
        ctx.pending_cta.awaitsConfirmation === true
    );
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
        ctxPatch: finalCtxPatch,
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

  async function tryBusinessInfoOutsideFastpath(params: {
    intent: string | null;
  }): Promise<boolean> {
    const routeIntent = String(params.intent || "").trim() || null;

    const { getRecentHistoryForModel } = await import(
      "../../lib/channels/engine/messages/getRecentHistoryForModel"
    );

    const { answerWithPromptBase } = await import(
      "../../lib/answers/answerWithPromptBase"
    );

    const history = await getRecentHistoryForModel({
      tenantId: tenant.id,
      canal,
      fromNumber: contactoNorm,
      excludeMessageId: messageId || null,
      limit: 12,
    });

    const composed = await answerWithPromptBase({
      tenantId: tenant.id,
      promptBase: promptBaseMem,
      userInput: ["USER_MESSAGE:", userInput].join("\n"),
      history,
      idiomaDestino,
      canal,
      maxLines: MAX_WHATSAPP_LINES,
      fallbackText: await getBienvenidaPorCanal("whatsapp", tenant, idiomaDestino),
    });

    if (composed.pendingCta) {
      const pendingCtaPatch = {
        pending_cta: {
          ...composed.pendingCta,
          createdAt: new Date().toISOString(),
        },
      };

      transition({ patchCtx: pendingCtaPatch });
      finalCtxPatch = {
        ...finalCtxPatch,
        ...pendingCtaPatch,
      };
    }

    const finalBusinessInfoText = await ensureReplyLanguage(
      String(composed.text || "").trim(),
      idiomaDestino,
      tenantBase
    );

    if (!finalBusinessInfoText) {
      return false;
    }

    INTENCION_FINAL_CANONICA = routeIntent;
    lastIntent = routeIntent;

    await replyAndExit(
      finalBusinessInfoText,
      "business_info_outside_fastpath",
      routeIntent
    );

    return true;
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

  const hasPendingCta = hasPendingCtaAwaitingConfirmation(convoCtx);

  if (hasPendingCta) {
    console.log("[WHATSAPP][PENDING_CTA_AWAITING_GATE]", {
      tenantId: tenant.id,
      canal,
      contactoNorm,
      userInput,
      pendingCta: (convoCtx as any)?.pending_cta ?? null,
    });
  }

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
  //    🔒 NO corre si hay CTA pendiente esperando confirmación
  // ===============================
  if (!inBooking0 && !hasPendingCta) {
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
      finalCtxPatch = { ...finalCtxPatch, ...fpRes.ctxPatch };
    }

    if (!fpRes.handled && fpRes.routeTarget === "business_info") {
      const handledBusinessInfo = await tryBusinessInfoOutsideFastpath({
        intent:
          fpRes.intent ||
          signals?.INTENCION_FINAL_CANONICA ||
          INTENCION_FINAL_CANONICA ||
          signals?.detectedIntent ||
          detectedIntent ||
          null,
      });

      if (handledBusinessInfo) {
        return;
      }
    }

    if (fpRes.handled && fpRes.reply) {
      if (hasPendingCta) {
        const stalePendingCtaPatch = {
          pending_cta: null,
          awaiting_yes_no_action: null,
          awaiting_yesno: false,
          yesno_resolution: null,
        };

        transition({ patchCtx: stalePendingCtaPatch });
        finalCtxPatch = {
          ...finalCtxPatch,
          ...stalePendingCtaPatch,
        };
      }

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
    console.log("🔒 FASTPATH SKIPPED", {
      bookingStep0,
      hasPendingCta,
      reason: inBooking0 ? "booking_activo" : "pending_cta_awaiting_confirmation",
    });
  }

  // ===============================
  // 🤖 STATE MACHINE TURN (extraído a helper)
  //    🔒 NO corre si hay booking activo
  // ===============================
  if (!inBooking0) {
    const smTurn = await handleStateMachineTurn({
      pool,
      sm,
      tenant,
      canal,
      contactoNorm,
      userInput,
      messageId: messageId || null,
      idiomaDestino,
      promptBase,
      tenantId: tenant.id,
      replyAndExit,
      applyTransitionAndPersist: async (smTransition) => {
        transition({
          flow: smTransition.flow,
          step: smTransition.step,
          patchCtx: smTransition.patchCtx || {},
        });

        await setConversationStateCompat(tenant.id, canal, contactoNorm, {
          activeFlow,
          activeStep,
          context: convoCtx,
        });
      },
      parseDatosCliente,
      extractPaymentLinkFromPrompt: null,
      PAGO_CONFIRM_REGEX: null,
    });

    if (smTurn.handled) {
      if (smTurn.replied) {
        return;
      }

      if (smTurn.activatedBooking) {
        if (await tryBooking("guardrail", "sm_transition_booking")) {
          return;
        }
      }

      if (smTurn.activatedEstimate) {
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

        return;
      }

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

      if (!phishingReply) {
        console.warn("[WHATSAPP][PHISHING_WITHOUT_REPLY]", {
          tenantId: tenant.id,
          canal,
          contactoNorm,
          userInput,
        });
        return;
      }

      return await replyAndExit(
        phishingReply,
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

  // ===============================
  // 🚫 SIN FALLBACK CONVERSACIONAL EN EL WEBHOOK
  // El turno no fue resuelto por booking / estimate / fastpath / state machine.
  // A partir de aquí, cualquier caso faltante se corrige en runFastpath,
  // no agregando otro motor de respuesta aquí.
  // ===============================
  if (!replied) {
    console.warn("[WHATSAPP][UNHANDLED_TURN_AFTER_ORCHESTRATION]", {
      tenantId: tenant.id,
      canal,
      contactoNorm,
      userInput,
      detectedIntent,
      intentFinalCanonica: INTENCION_FINAL_CANONICA,
      activeFlow,
      activeStep,
      hasPendingCta,
      inBooking0,
    });
    return;
  }
}