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
import { isExplicitHumanRequest } from "../../lib/security/humanOverrideGate";
import { looksLikeShortLabel } from "../../lib/channels/engine/lang/looksLikeShortLabel";
import { runFastpath } from "../../lib/fastpath/runFastpath";
import { naturalizeSecondaryOptionsLine } from "../../lib/fastpath/naturalizeSecondaryOptions";

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
      forcedLangThisTurn = forcedLang;

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
  const storedLang = await getIdiomaClienteDB(
    pool,
    tenant.id,
    canal,
    contactoNorm,
    tenantBase
  );

  // ✅ LANG EARLY-LOCK: si está eligiendo de listas del ctx, NO recalcules idioma este turno
  const isChoosing = (storedLang === "es" || storedLang === "en")
    ? isChoosingFromCtxLists(convoCtx, userInput)
    : false;

  if (isChoosing) {
    idiomaDestino = storedLang as any;
    forcedLangThisTurn = idiomaDestino;
    console.log("🌍 LANG EARLY-LOCK (ctx list pick) =>", { userInput, storedLang });
  }

  const langRes = forcedLangThisTurn
    ? {
        finalLang: forcedLangThisTurn,
        detectedLang: forcedLangThisTurn,
        lockedLang: true,
        inBookingLang: false,
      }
    : await resolveTurnLangClientFirst({
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

  // Idioma base propuesto por el resolver
  if (forcedLangThisTurn) {
    idiomaDestino = forcedLangThisTurn;
  } else {
    idiomaDestino = langRes.finalLang;
  }

  /**
   * ✅ REGLA EXTRA: saludo bilingüe "Hi hola / hi buenas..."
   * Caso típico:
   *   "Hi hola buenas tardes estoy interesada..."
   *
   * Si el tenant o el cliente son ES, y el mensaje es un saludo mixto
   * EN + ES, preferimos ESPAÑOL.
   */
  const bilingualGreeting = /^\s*(hi|hello)\s+(hola|buenas|buenos)\b/i.test(
    userInput || ""
  );

  if (
    !langRes.inBookingLang &&
    bilingualGreeting &&
    (storedLang === "es" || tenantBase === "es")
  ) {
    console.log("🌍 LANG OVERRIDE (bilingual greeting → es)", {
      userInput,
      storedLang,
      tenantBase,
      prevLang: idiomaDestino,
    });
    idiomaDestino = "es";
  }

  /**
   * Pequeño extra genérico: si hay caracteres claramente españoles
   * (á, é, í, ó, ú, ñ, ¿, ¡) y el tenant base es ES, y el detector dijo EN,
   * inclinamos a ES. Esto es cross-industria.
   */
  const hasStrongEsChars = /[áéíóúñ¿¡]/i.test(userInput || "");

  if (
    !langRes.inBookingLang &&
    hasStrongEsChars &&
    idiomaDestino === "en" &&
    (tenantBase === "es" || storedLang === "es")
  ) {
    console.log("🌍 LANG OVERRIDE (accent chars → es)", {
      userInput,
      storedLang,
      tenantBase,
      prevLang: idiomaDestino,
    });
    idiomaDestino = "es";
  }

  // ✅ Persistir idioma final del turno (sticky)
  // (pero NO lo sobrescribas si es booking lang locked)
  if (!langRes.inBookingLang && (idiomaDestino === "es" || idiomaDestino === "en")) {
    await upsertIdiomaClienteDB(
      pool,
      tenant.id,
      canal,
      contactoNorm,
      idiomaDestino
    );
  }

  // ✅ NO CAMBIAR IDIOMA por tokens cortos tipo "Indoor cycling", "Deluxe Groom", etc.
  // Si el hilo ya tiene idioma (storedLang) y el input parece label corto, quédate con storedLang.
  if (
    !langRes.inBookingLang &&
    (storedLang === "es" || storedLang === "en") &&
    (langRes.detectedLang === "es" || langRes.detectedLang === "en") &&
    langRes.detectedLang !== storedLang &&
    looksLikeShortLabel(userInput)
  ) {
    idiomaDestino = storedLang as any;
  }

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

  // Tokens de talla (S/M/L) → mantén storedLang
  const tLower = String(userInput || "").trim().toLowerCase();
  const isSizeToken = /^(small|medium|large|x-large|xl|xs|peque(n|ñ)o|mediano|grande)$/i.test(
    tLower
  );

  if (isSizeToken && (storedLang === "es" || storedLang === "en")) {
    idiomaDestino = storedLang as any;
  }

  // ✅ NO CAMBIAR IDIOMA cuando el usuario está seleccionando una opción
  // Ej: "cycling autopay", "bronze por mes", etc.
  {
    const normalizeChoice = (s: string) =>
      String(s || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const u = normalizeChoice(userInput);

    const hasRecentList = (() => {
      const ttlMs = 10 * 60 * 1000;
      const at1 = Number((convoCtx as any)?.last_plan_list_at || 0);
      const at2 = Number((convoCtx as any)?.last_package_list_at || 0);
      const fresh1 = at1 > 0 && Date.now() - at1 <= ttlMs;
      const fresh2 = at2 > 0 && Date.now() - at2 <= ttlMs;

      const lp = Array.isArray((convoCtx as any)?.last_plan_list)
        ? (convoCtx as any).last_plan_list
        : [];
      const pk = Array.isArray((convoCtx as any)?.last_package_list)
        ? (convoCtx as any).last_package_list
        : [];

      return (fresh1 && lp.length > 0) || (fresh2 && pk.length > 0);
    })();

    const matchesListItem = (() => {
      if (!u) return false;

      const candidates: Array<{ name?: string; label?: string; text?: string }> = [
        ...(((convoCtx as any)?.last_plan_list || []) as any[]),
        ...(((convoCtx as any)?.last_package_list || []) as any[]),
        ...(((convoCtx as any)?.last_service_list || []) as any[]),
      ];

      return candidates.some((it) => {
        const n = normalizeChoice(it?.name || it?.label || it?.text || "");
        if (!n) return false;
        return n.includes(u) || u.includes(n);
      });
    })();

    if (hasRecentList && matchesListItem) {
      const locked =
        storedLang === "es" || storedLang === "en"
          ? storedLang
          : (idiomaDestino || tenantBase);

      idiomaDestino = locked as any;
      console.log("🌍 LANG LOCK (choice token, no flip) =>", {
        userInput,
        storedLang,
        locked,
        tenantBase,
      });
    }
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
  // ⚡ FASTPATH (extraído a módulo reusable)
  // ===============================
  {
    const fp = await runFastpath({
      pool,
      tenantId: tenant.id,
      canal,
      idiomaDestino,
      userInput,
      inBooking: Boolean(inBooking0),
      convoCtx: convoCtx as any,
      infoClave: String(tenant?.info_clave || ""),
      detectedIntent: detectedIntent || INTENCION_FINAL_CANONICA || null,
      maxDisambiguationOptions: 5,
      lastServiceTtlMs: 60 * 60 * 1000,
    });

    // aplicar patch de contexto
    if (fp.ctxPatch) transition({ patchCtx: fp.ctxPatch });

    // aplicar efectos (awaiting) fuera del módulo
    if (fp.handled && fp.awaitingEffect?.type === "set_awaiting_yes_no") {
      const { setAwaitingState } = await import("../../lib/awaiting/setAwaitingState");
      await setAwaitingState(pool, {
        tenantId: tenant.id,
        canal,
        senderId: contactoNorm,
        field: "yes_no",
        payload: fp.awaitingEffect.payload,
        ttlSeconds: fp.awaitingEffect.ttlSeconds,
      });
    }

    if (fp.handled) {
      // ✅ Texto “factual” que viene de Fastpath (precios, includes, listas, etc.)
      let fastpathText = fp.reply;

      const isPlansList =
        fp.source === "service_list_db" &&
        (convoCtx as any)?.last_list_kind === "plan";

      const hasPkgs = (convoCtx as any)?.has_packages_available === true;

      // 🔍 NUEVO: detectar si fastpath ya trae link o viene de info_clave_*
      const hasLinkInFastpath = /https?:\/\/\S+/i.test(fastpathText);
      const isInfoClaveSource = String(fp.source || "").startsWith("info_clave");

      // 🛑 BYPASS LLM EN WHATSAPP SI YA TENEMOS LINK O ES INFO_CLAVE
      if (canal === "whatsapp" && (hasLinkInFastpath || isInfoClaveSource)) {
        console.log("[WHATSAPP][FASTPATH] Bypass LLM (link/info_clave)", {
          source: fp.source,
          hasLinkInFastpath,
        });

        return await replyAndExit(fastpathText, fp.source, fp.intent);
      }

      // Para otros canales (meta, sms…), mantenemos la naturalización secundaria
      if (canal !== "whatsapp" && isPlansList && hasPkgs) {
        fastpathText = await naturalizeSecondaryOptionsLine({
          tenantId: tenant.id,
          idiomaDestino,
          canal,
          baseText: fastpathText,
          primary: "plans",
          secondaryAvailable: true,
          maxLines: MAX_WHATSAPP_LINES,
        });
      }

      // 🌀 MODO HÍBRIDO SOLO CUANDO NO HAY LINK DIRECTO
      if (canal === "whatsapp") {
        const history = await getRecentHistoryForModel({
          tenantId: tenant.id,
          canal,
          fromNumber: contactoNorm,
          excludeMessageId: messageId,
          limit: 12,
        });

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
            ? "RULE: Do not invent exact prices. Only mention prices if explicitly present in the provided business info or in SYSTEM_STRUCTURED_DATA, and preserve ranges/qualifiers."
            : "REGLA: No inventes precios exactos. Solo menciona precios si están explícitos en la info del negocio o en DATOS_ESTRUCTURADOS_DEL_SISTEMA, y preserva rangos/calificativos (DESDE).";

        // 🚀 Prompt base + datos estrictos de Fastpath
        const promptConFastpath = [
          promptBaseMem,
          "",
          "DATOS_ESTRUCTURADOS_DEL_SISTEMA (úsalos como fuente de verdad, sin cambiar montos ni nombres de planes/servicios):",
          fastpathText,
          "",
          "INSTRUCCIONES_DE_ESTILO_PARA_ESTE TURNO:",
          NO_NUMERIC_MENUS,
          PRICE_QUALIFIER_RULE,
          NO_PRICE_INVENTION_RULE,
          "",
          idiomaDestino === "en"
            ? "RULE: You may rephrase for a natural WhatsApp tone, but DO NOT change amounts, ranges, or plan/service names."
            : "REGLA: Puedes re-redactar para que suene natural en WhatsApp, pero NO cambies montos, rangos ni nombres de planes/servicios.",
        ].join("\n");

        const composed = await answerWithPromptBase({
          tenantId: tenant.id,
          promptBase: promptConFastpath,
          userInput,                     // el mensaje real del cliente
          history,
          idiomaDestino,
          canal: "whatsapp",
          maxLines: MAX_WHATSAPP_LINES,
          fallbackText: fastpathText,    // si falla el LLM, enviamos al menos lo de Fastpath
        });

        // ================================================
        // PASO 1 — Detect CTA del LLM y preparar awaiting_yes_no_action
        // ================================================
        {
          const text = (composed.text || "").toLowerCase().trim();

          // Detecta si el LLM está haciendo una pregunta YES/NO natural
          const isYesNoCTA =
            /\?\s*$/.test(text) &&
            (
              /\bte gustar[íi]a\b/.test(text) ||
              /\bquieres\b/.test(text) ||
              /\bdeseas\b/.test(text) ||
              /\bwould you like\b/.test(text) ||
              /\bdo you want\b/.test(text)
            );

          if (isYesNoCTA) {
            // El LLM mencionó un servicio en texto
            // Intentamos recuperarlo del ctx (fastpath ya resolvió last_service_id)
            const sid = (convoCtx as any)?.last_service_id || null;
            const sname = (convoCtx as any)?.last_service_name || null;

            let serviceUrl: string | null = null;
            if (sid) {
              const r = await pool.query(
                `SELECT service_url FROM services WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
                [sid, tenant.id]
              );
              serviceUrl = r.rows[0]?.service_url || null;
            }

            if (sid && serviceUrl) {
              transition({
                patchCtx: {
                  awaiting_yes_no_action: {
                    kind: "cta_yes_no_service",
                    serviceId: sid,
                    label: sname || "Reserva",
                    link: serviceUrl
                  }
                }
              });
            }
          }
        }

        return await replyAndExit(composed.text, fp.source, fp.intent);
      }

      // 🔁 Para otros canales, seguimos devolviendo el texto de Fastpath directamente
      return await replyAndExit(fastpathText, fp.source, fp.intent);
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