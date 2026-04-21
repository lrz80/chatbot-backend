// backend/src/routes/webhook/whatsapp.ts

import { Router, Request, Response } from 'express';
import pool from '../../lib/db';
import twilio from 'twilio';

import { detectarIdioma } from '../../lib/detectarIdioma';
import { enviarWhatsApp } from "../../lib/senders/whatsapp";
import type {
  Canal,
  CommercialSignal,
} from '../../lib/detectarIntencion';
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
import {
  ensureClienteBase,
  upsertIdiomaClienteDB,
  getSelectedChannelDB,
  upsertSelectedChannelDB,
} from "../../lib/channels/engine/clients/clientDb";
import {
  normalizeLangCode,
  type LangCode,
} from "../../lib/i18n/lang";
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

import { renderFastpathDmReply } from "../../lib/channels/engine/fastpath/renderFastpathDmReply";
import { resolveBusinessInfoOverviewCanonicalBody } from "../../lib/channels/engine/businessInfo/resolveBusinessInfoOverviewCanonicalBody";

import { resolveUnhandledTurnFallback } from "../../lib/channels/engine/fallback/resolveUnhandledTurnFallback";
import { runCatalogDomainTurn } from "../../lib/fastpath/runCatalogDomainTurn";
import { resolveBusinessInfoFacetsCanonicalBody } from "../../lib/channels/engine/businessInfo/resolveBusinessInfoFacetsCanonicalBody";
import {
  buildFastpathReplyPolicy,
  buildStaticFastpathReplyPolicy,
} from "../../lib/channels/engine/fastpath/buildFastpathReplyPolicy";

import { buildCatalogTurnAugmentation } from '../../lib/channels/engine/turn/buildCatalogTurnAugmentation';
import type { VisualTurnEvidence } from '../../lib/channels/engine/turn/types';

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

type ExternalActionConfig = {
  id: string;
  enabled: boolean;
  channel: "link";
  dispatchPolicy: "affirmative_continuation";
  url: string;
  allowedDomains?: Array<"business_info" | "catalog" | "booking" | "other">;
  canonicalBody?: string | null;
  canonicalBodyByLang?: Partial<Record<LangCode, string>>;
};

type ExternalActionContext = {
  type: "external_action";
  channel: "link";
  dispatchPolicy: "affirmative_continuation";
  targetUrl: string;
  sourceDomain: "business_info" | "catalog" | "booking" | "other";
  createdAt: string;
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
  let detectedCommercial: CommercialSignal | null = null;

  let replied = false;

  const turn = await buildTurnContext({ pool, body, context });

  // canal puede venir en el contexto (meta/preview) o por defecto 'whatsapp'
  const canal: Canal = (context?.canal as Canal) || "whatsapp";

  const userInput = turn.userInputRaw;
  const messageId = turn.messageId;

  const numMedia = Number(body?.NumMedia || 0);
  const captionText =
    typeof body?.Body === "string" && body.Body.trim().length > 0
      ? body.Body.trim()
      : null;

  let visualEvidence: VisualTurnEvidence | null = null;

  if (numMedia > 0) {
    const mediaContentType = String(body?.MediaContentType0 || "");
    const mediaUrl = String(body?.MediaUrl0 || "");

    visualEvidence = {
      hasVisualReference: mediaContentType.startsWith("image/") || Boolean(mediaUrl),
      extractedText: [],
      confidence: 0,
      source: "none",
    };
  }

  const turnAugmentation = buildCatalogTurnAugmentation({
    userText: userInput,
    captionText,
    visualEvidence,
  });

  const tenant = turn.tenant;

  if (!tenant) {
    console.log("⛔ No se encontró tenant para este inbound (buildTurnContext).");
    return;
  }

  // ⚡ No hacemos 2 queries a DB: cache local del turno
  const waModePromise = getWhatsAppModeStatus(tenant.id);

  // 👉 idioma base del tenant (fallback)
  const tenantBase: LangCode = normalizeLangCode(tenant?.idioma) ?? "es";
  let idiomaDestino: LangCode = tenantBase;
  let forcedLangThisTurn: LangCode | null = null;

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

  // ✅ whatsapp.ts no fuerza idioma por contenido parcial.
  // La resolución de idioma vive en resolveLangForTurn().
  forcedLangThisTurn = null;

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
    targetLang: LangCode
  ): Promise<string> {
    const raw = String(text || "").trim();
    if (!raw) return raw;

    const normalizedTargetLang = normalizeLangCode(targetLang);
    if (!normalizedTargetLang) return raw;

    try {
      const detected = await detectarIdioma(raw);
      const replyLang = normalizeLangCode(detected.lang);

      // Si no se pudo detectar, no forzamos nada.
      if (!replyLang) {
        return raw;
      }

      // Ya está en el idioma correcto
      if (replyLang === normalizedTargetLang) {
        return raw;
      }

      // Traducir al idioma del turno actual
      return await traducirMensaje(raw, normalizedTargetLang);
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
    if (!ctx || typeof ctx !== "object") {
      return false;
    }

    const pendingCta =
      ctx.pending_cta && typeof ctx.pending_cta === "object"
        ? ctx.pending_cta
        : null;

    const awaitingYesNoAction =
      ctx.awaiting_yes_no_action && typeof ctx.awaiting_yes_no_action === "object"
        ? ctx.awaiting_yes_no_action
        : null;

    const hasPendingCtaKind =
      typeof pendingCta?.kind === "string" &&
      pendingCta.kind.trim() === "pending_cta";

    const hasPendingCtaType =
      typeof pendingCta?.ctaType === "string" && pendingCta.ctaType.trim()
        ? true
        : typeof pendingCta?.type === "string" && pendingCta.type.trim()
        ? true
        : false;

    const hasAwaitingPendingCta =
      typeof awaitingYesNoAction?.kind === "string" &&
      awaitingYesNoAction.kind.trim() === "pending_cta";

    return Boolean(
      hasPendingCtaKind &&
        hasPendingCtaType &&
        hasAwaitingPendingCta
    );
  }

  function shouldTreatTurnAsPendingCtaConfirmation(params: {
    userInput: string;
    resolvedIntent: string | null;
  }): boolean {
    const raw = String(params.userInput || "").trim();
    const normalizedIntent = String(params.resolvedIntent || "")
      .trim()
      .toLowerCase();

    if (!raw) return false;

    const tokenCount = raw.split(/\s+/).filter(Boolean).length;
    const hasQuestionMark = /[?¿]/.test(raw);

    if (hasQuestionMark) return false;

    if (normalizedIntent && normalizedIntent !== "duda") {
      return false;
    }

    return tokenCount <= 3;
  }

  function selectExternalActionForDomain(params: {
    tenant: any;
    sourceDomain: "business_info" | "catalog" | "booking" | "other";
  }): ExternalActionContext | null {
    const bookingUrl =
      String(
        params.tenant?.booking_url ||
        params.tenant?.bookingUrl ||
        params.tenant?.settings?.booking?.booking_url ||
        ""
      ).trim();

    console.log("[EXTERNAL_ACTION][SELECT_INPUT]", {
      sourceDomain: params.sourceDomain,
      tenantBookingUrl: params.tenant?.booking_url ?? null,
      tenantBookingUrlCamel: params.tenant?.bookingUrl ?? null,
      tenantSettingsBookingUrl:
        params.tenant?.settings?.booking?.booking_url ?? null,
    });

    if (!bookingUrl) {
      console.log("[EXTERNAL_ACTION][SELECT_NONE]", {
        reason: "missing_booking_url",
        sourceDomain: params.sourceDomain,
      });
      return null;
    }

    if (params.sourceDomain !== "business_info") {
      console.log("[EXTERNAL_ACTION][SELECT_NONE]", {
        reason: "unsupported_source_domain",
        sourceDomain: params.sourceDomain,
        bookingUrl,
      });
      return null;
    }

    const action: ExternalActionContext = {
      type: "external_action",
      channel: "link",
      dispatchPolicy: "affirmative_continuation",
      targetUrl: bookingUrl,
      sourceDomain: params.sourceDomain,
      createdAt: new Date().toISOString(),
    };

    console.log("[EXTERNAL_ACTION][SELECTED]", action);

    return action;
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
        rememberAfterReply: (args: any) => {
          const normalizedReplySource =
            typeof args?.replySource === "string" && args.replySource.trim()
              ? args.replySource.trim()
              : typeof args?.source === "string" && args.source.trim()
              ? args.source.trim()
              : null;

          return rememberAfterReply({
            ...args,
            canal: "whatsapp",
            replySource: normalizedReplySource,
          });
        },
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
        detectedCommercial: (signals as any)?.detectedCommercial ?? null,

        convoCtx,
      });
    } catch (e: any) {
      console.warn("⚠️ runPostReplyActions failed:", e?.message);
    }
  }

  async function replyAndExit(text: string, source: string, intent?: string | null) {
    const finalText = await ensureReplyLanguage(
      text,
      idiomaDestino
    );

    setReply(finalText, source, intent);
    await finalizeReply();
    return;
  }

  function shouldUseGuidedBusinessEntryOutsideFastpath(params: {
    routeTarget?: "catalog" | "business_info" | "continue_pipeline";
    detectedIntent: string | null;
    intentFallback: string | null;
    detectedFacets?: IntentFacets | null;
    detectedCommercial?: CommercialSignal | null;
  }): boolean {
    const resolvedIntent = String(
      params.detectedIntent || params.intentFallback || ""
    )
      .trim()
      .toLowerCase();

    const asksSchedules = params.detectedFacets?.asksSchedules === true;
    const asksPrices = params.detectedFacets?.asksPrices === true;
    const asksLocation = params.detectedFacets?.asksLocation === true;
    const asksAvailability = params.detectedFacets?.asksAvailability === true;

    return (
      params.routeTarget === "continue_pipeline" &&
      !asksSchedules &&
      !asksPrices &&
      !asksLocation &&
      !asksAvailability &&
      params.detectedCommercial?.wantsBooking !== true &&
      params.detectedCommercial?.wantsQuote !== true &&
      params.detectedCommercial?.wantsHuman !== true &&
      (
        !resolvedIntent ||
        resolvedIntent === "duda" ||
        resolvedIntent === "info_general"
      )
    );
  }

  function shouldAcknowledgePostEstimateCompletion(params: {
    activeFlow: string | null;
    activeStep: string | null;
    detectedIntent: string | null;
    intentFallback: string | null;
    userInput: string;
  }): boolean {
    const activeFlow = String(params.activeFlow || "").trim().toLowerCase();
    const activeStep = String(params.activeStep || "").trim().toLowerCase();
    const resolvedIntent = String(
      params.intentFallback || params.detectedIntent || ""
    )
      .trim()
      .toLowerCase();

    if (activeFlow !== "estimate_flow") {
      return false;
    }

    if (activeStep !== "scheduled") {
      return false;
    }

    if (resolvedIntent === "saludo" || resolvedIntent === "despedida") {
      return true;
    }

    return false;
  }

  function shouldPersistExternalActionForBusinessInfo(params: {
    resolvedBusinessIntent: string;
    overviewMode: "general_overview" | "guided_entry";
    wantsBusinessFacets: boolean;
    asksSchedules: boolean;
    asksLocation: boolean;
    asksAvailability: boolean;
  }): boolean {
    if (params.overviewMode === "guided_entry") {
      return false;
    }

    if (!params.wantsBusinessFacets) {
      return false;
    }

    if (params.asksLocation || params.asksAvailability) {
      return false;
    }

    return params.asksSchedules && params.resolvedBusinessIntent === "horario";
  }

  async function tryBusinessInfoOutsideFastpath(params: {
    intent: string | null;
    detectedFacets?: IntentFacets | null;
    overviewMode?: "general_overview" | "guided_entry";
  }): Promise<boolean> {
    const routeIntent = String(params.intent || "").trim() || "info_general";
    const overviewMode = params.overviewMode ?? "general_overview";

    const explicitAsksSchedules = params.detectedFacets?.asksSchedules === true;
    const explicitAsksLocation = params.detectedFacets?.asksLocation === true;
    const explicitAsksAvailability = params.detectedFacets?.asksAvailability === true;

    const continuationLastTurn = convoCtx?.continuationContext?.lastTurn ?? null;

    const continuedBusinessInfoIntent =
      continuationLastTurn?.domain === "business_info"
        ? String(continuationLastTurn.intent || "").trim().toLowerCase()
        : "";

    const inheritedAsksSchedules =
      !explicitAsksSchedules &&
      !explicitAsksLocation &&
      !explicitAsksAvailability &&
      continuedBusinessInfoIntent === "horario";

    const inheritedAsksLocation =
      !explicitAsksSchedules &&
      !explicitAsksLocation &&
      !explicitAsksAvailability &&
      continuedBusinessInfoIntent === "ubicacion";

    const inheritedAsksAvailability =
      !explicitAsksSchedules &&
      !explicitAsksLocation &&
      !explicitAsksAvailability &&
      continuedBusinessInfoIntent === "disponibilidad";

    const asksSchedules = explicitAsksSchedules || inheritedAsksSchedules;
    const asksLocation = explicitAsksLocation || inheritedAsksLocation;
    const asksAvailability = explicitAsksAvailability || inheritedAsksAvailability;

    const wantsBusinessFacets =
      asksSchedules || asksLocation || asksAvailability;

    const canonicalBusinessInfoBody = wantsBusinessFacets
      ? await resolveBusinessInfoFacetsCanonicalBody({
          pool,
          tenantId: tenant.id,
          canal,
          idiomaDestino,
          userInput,
          promptBaseMem,
          infoClave: String(tenant?.info_clave || ""),
          convoCtx,
          facets: {
            asksSchedules,
            asksLocation,
            asksAvailability,
          },
          routingHints: (signals as any)?.detectedRoutingHints || null,
        })
      : await resolveBusinessInfoOverviewCanonicalBody({
          tenantId: tenant.id,
          canal,
          idiomaDestino,
          userInput,
          promptBaseMem,
          infoClave: String(tenant?.info_clave || ""),
          convoCtx,
          overviewMode,
        });

    const normalizedCanonicalBody = String(canonicalBusinessInfoBody || "").trim();

    if (!normalizedCanonicalBody) {
      console.warn("[BUSINESS_INFO][EMPTY_CANONICAL_BODY]", {
        tenantId: tenant.id,
        canal,
        contactoNorm,
        userInput,
        routeIntent,
        wantsBusinessFacets,
        continuedBusinessInfoIntent,
        facets: {
          asksSchedules,
          asksLocation,
          asksAvailability,
        },
      });
      return false;
    }

    const resolvedBusinessIntent =
      wantsBusinessFacets
        ? asksSchedules && !asksLocation && !asksAvailability
          ? "horario"
          : asksLocation && !asksSchedules && !asksAvailability
          ? "ubicacion"
          : asksAvailability && !asksSchedules && !asksLocation
          ? "disponibilidad"
          : "info_general"
        : routeIntent;

    const shouldPersistExternalAction =
      shouldPersistExternalActionForBusinessInfo({
        resolvedBusinessIntent,
        overviewMode,
        wantsBusinessFacets,
        asksSchedules,
        asksLocation,
        asksAvailability,
      });

    const nextActionContext = shouldPersistExternalAction
      ? selectExternalActionForDomain({
          tenant,
          sourceDomain: "business_info",
        })
      : null;

    const rendered = await renderFastpathDmReply({
      tenantId: tenant.id,
      canal,
      idiomaDestino,
      userInput,
      contactoNorm,
      messageId: messageId || null,
      promptBaseMem,
      fastpathText: normalizedCanonicalBody,
      fp: {
        reply: normalizedCanonicalBody,
        source: wantsBusinessFacets
          ? "info_clave_db"
          : overviewMode === "guided_entry"
          ? "info_general_guided_entry_db"
          : "info_general_overview_db",
        intent: resolvedBusinessIntent,
        catalogPayload: undefined,
      },
      detectedIntent: resolvedBusinessIntent,
      intentFallback: resolvedBusinessIntent,
      structuredService: {
        serviceId: null,
        serviceName: null,
        serviceLabel: null,
        hasResolution: false,
      },
      replyPolicy: buildStaticFastpathReplyPolicy({
        canal,
        answerType: wantsBusinessFacets ? "direct_answer" : "overview",
        replySourceKind: "business_info",
        responsePolicyMode: "grounded_frame_only",
        hasResolvedEntity: false,
        isCatalogDbReply: false,
        isPriceSummaryReply: false,
        isPriceDisambiguationReply: false,
        isGroundedCatalogReply: false,
        isGroundedCatalogOverviewDm: !wantsBusinessFacets,
        shouldForceSalesClosingQuestion: false,
        shouldUseGroundedFrameOnly: true,
        canonicalBodyOwnsClosing: false,
        clarificationTarget: null,
        commercialPolicy: {
          purchaseIntent: detectedCommercial?.purchaseIntent ?? "low",
          wantsBooking: detectedCommercial?.wantsBooking === true,
          wantsQuote: detectedCommercial?.wantsQuote === true,
          wantsHuman: detectedCommercial?.wantsHuman === true,
          urgency: detectedCommercial?.urgency ?? "low",
          shouldUseSalesTone: true,
          shouldUseSoftClosing: true,
          shouldUseDirectClosing: false,
          shouldSuggestHumanHandoff: detectedCommercial?.wantsHuman === true,
        },
      }),
      ctxPatch: {
        ...(finalCtxPatch || {}),
        actionContext: nextActionContext,
      },
      maxLines: MAX_WHATSAPP_LINES,
    });

    if (rendered.ctxPatch) {
      transition({ patchCtx: rendered.ctxPatch });
      finalCtxPatch = {
        ...finalCtxPatch,
        ...rendered.ctxPatch,
      };
    }

    const finalBusinessInfoText = await ensureReplyLanguage(
      String(rendered.reply || "").trim(),
      idiomaDestino
    );

    if (!finalBusinessInfoText) {
      return false;
    }

    INTENCION_FINAL_CANONICA = resolvedBusinessIntent;
    lastIntent = resolvedBusinessIntent;

    await replyAndExit(
      finalBusinessInfoText,
      wantsBusinessFacets
        ? "business_info_facets_outside_fastpath"
        : "business_info_outside_fastpath",
      resolvedBusinessIntent
    );

    return true;
  }

  async function tryExternalActionContextContinuation(params: {
    intent: string | null;
    detectedFacets?: IntentFacets | null;
  }): Promise<boolean> {
    const actionContext = convoCtx?.actionContext as ExternalActionContext | null;

    if (!actionContext || typeof actionContext !== "object") {
      return false;
    }

    if (actionContext.type !== "external_action") {
      return false;
    }

    if (actionContext.channel !== "link") {
      return false;
    }

    if (actionContext.dispatchPolicy !== "affirmative_continuation") {
      return false;
    }

    if (!String(actionContext.targetUrl || "").trim()) {
      return false;
    }

    const explicitAsksSchedules = params.detectedFacets?.asksSchedules === true;
    const explicitAsksLocation = params.detectedFacets?.asksLocation === true;
    const explicitAsksAvailability = params.detectedFacets?.asksAvailability === true;

    if (explicitAsksSchedules || explicitAsksLocation || explicitAsksAvailability) {
      return false;
    }

    const resolvedIntent = String(params.intent || "").trim().toLowerCase() || null;

    const looksLikeAffirmativeContinuation =
      shouldTreatTurnAsPendingCtaConfirmation({
        userInput,
        resolvedIntent,
      });

    if (!looksLikeAffirmativeContinuation) {
      return false;
    }

    const rendered = await renderFastpathDmReply({
      tenantId: tenant.id,
      canal,
      idiomaDestino,
      userInput,
      contactoNorm,
      messageId: messageId || null,
      promptBaseMem,
      fastpathText: actionContext.targetUrl,
      fp: {
        reply: actionContext.targetUrl,
        source: "external_action_link",
        intent: "external_action",
        externalAction: {
          type: "link",
          targetUrl: actionContext.targetUrl,
        },
        catalogPayload: undefined,
      },
      detectedIntent: "external_action",
      intentFallback: "external_action",
      structuredService: {
        serviceId: null,
        serviceName: null,
        serviceLabel: null,
        hasResolution: false,
      },
      replyPolicy: buildStaticFastpathReplyPolicy({
        canal,
        answerType: "action_link",
        replySourceKind: "business_info",
        responsePolicyMode: "grounded_frame_only",
        hasResolvedEntity: false,
        isCatalogDbReply: false,
        isPriceSummaryReply: false,
        isPriceDisambiguationReply: false,
        isGroundedCatalogReply: false,
        isGroundedCatalogOverviewDm: false,
        shouldForceSalesClosingQuestion: false,
        shouldUseGroundedFrameOnly: true,
        canonicalBodyOwnsClosing: false,
        clarificationTarget: null,
        commercialPolicy: {
          purchaseIntent: detectedCommercial?.purchaseIntent ?? "low",
          wantsBooking: detectedCommercial?.wantsBooking === true,
          wantsQuote: detectedCommercial?.wantsQuote === true,
          wantsHuman: detectedCommercial?.wantsHuman === true,
          urgency: detectedCommercial?.urgency ?? "low",
          shouldUseSalesTone: true,
          shouldUseSoftClosing: true,
          shouldUseDirectClosing: false,
          shouldSuggestHumanHandoff: detectedCommercial?.wantsHuman === true,
        },
      }),
      ctxPatch: {
        ...(finalCtxPatch || {}),
        actionContext: null,
        last_bot_action: "external_action_sent",
      },
      maxLines: MAX_WHATSAPP_LINES,
    });

    if (rendered.ctxPatch) {
      transition({ patchCtx: rendered.ctxPatch });
      finalCtxPatch = {
        ...finalCtxPatch,
        ...rendered.ctxPatch,
      };
    }

    const finalActionText = await ensureReplyLanguage(
      String(rendered.reply || "").trim(),
      idiomaDestino
    );

    if (!finalActionText) {
      return false;
    }

    INTENCION_FINAL_CANONICA = "external_action";
    lastIntent = "external_action";

    await replyAndExit(
      finalActionText,
      "external_action_link",
      "external_action"
    );

    return true;
  }

  async function tryCatalogOutsideHybridDecision(params: {
    intent: string | null;
    detectedFacets?: IntentFacets | null;
    convoCtxForCatalog: any;
    catalogReferenceClassification?: any;
    canonicalCatalogResolution?: {
      resolutionKind: string;
      resolvedServiceId?: string | null;
      resolvedServiceName?: string | null;
      variantOptions?: Array<{
        variantId: string;
        variantName: string;
      }>;
    };
  }): Promise<boolean> {
    const catalogRes = await runCatalogDomainTurn({
      pool,
      tenantId: tenant.id,
      canal,
      idiomaDestino,
      userInput,
      inBooking: Boolean(inBooking0),
      convoCtx: params.convoCtxForCatalog as any,
      infoClave: String(tenant?.info_clave || ""),
      detectedIntent: params.intent,
      detectedFacets: params.detectedFacets || {},
      catalogReferenceClassification: params.catalogReferenceClassification,
      maxDisambiguationOptions: 10,
      catalogRouteContext: {
        canonicalCatalogResolution: params.canonicalCatalogResolution,
      },
    });

    if (catalogRes.ctxPatch) {
      transition({ patchCtx: catalogRes.ctxPatch });
      finalCtxPatch = {
        ...finalCtxPatch,
        ...catalogRes.ctxPatch,
      };
    }

    if (!catalogRes.handled) {
      return false;
    }

    const catalogReply =
      "reply" in catalogRes && typeof catalogRes.reply === "string"
        ? catalogRes.reply
        : "";

    const catalogPayload =
      "catalogPayload" in catalogRes
        ? catalogRes.catalogPayload ?? undefined
        : undefined;

    const catalogSource =
      "source" in catalogRes && typeof catalogRes.source === "string"
        ? catalogRes.source
        : null;

    const catalogIntent =
      "intent" in catalogRes && typeof catalogRes.intent === "string"
        ? catalogRes.intent
        : params.intent;

    const catalogAwaitingEffect =
      "awaitingEffect" in catalogRes
        ? catalogRes.awaitingEffect ?? null
        : null;

    const rawCatalogText = String(catalogReply || "").trim();
    const hasCatalogPayload = Boolean(catalogPayload);

    // Las respuestas de desambiguación pueden venir sin texto
    // y renderizarse desde catalogPayload
    if (!rawCatalogText && !hasCatalogPayload) {
      return false;
    }

    const rendered = await renderFastpathDmReply({
      tenantId: tenant.id,
      canal,
      idiomaDestino,
      userInput,
      contactoNorm,
      messageId: messageId || null,
      promptBaseMem,
      fastpathText: rawCatalogText,
      fp: {
        reply: rawCatalogText,
        source: catalogSource || "catalog_route",
        intent: catalogIntent,
        awaitingEffect: catalogAwaitingEffect,
        catalogPayload,
      },
      detectedIntent: catalogIntent,
      intentFallback: catalogIntent,
      structuredService: {
        serviceId:
          catalogPayload?.kind === "resolved_catalog_answer"
            ? catalogPayload.serviceId || null
            : catalogPayload?.kind === "variant_choice"
            ? catalogPayload.serviceId || null
            : null,
        serviceName:
          catalogPayload?.kind === "resolved_catalog_answer"
            ? catalogPayload.serviceName || null
            : catalogPayload?.kind === "variant_choice"
            ? catalogPayload.serviceName || null
            : null,
        serviceLabel:
          catalogPayload?.kind === "resolved_catalog_answer"
            ? catalogPayload.serviceName || null
            : catalogPayload?.kind === "variant_choice"
            ? catalogPayload.serviceName || null
            : null,
        hasResolution:
          catalogPayload?.kind === "resolved_catalog_answer" &&
          (
            Boolean(catalogPayload.serviceId) ||
            Boolean(catalogPayload.variantId)
          ),
      },
      replyPolicy: buildFastpathReplyPolicy({
        canal,
        fp: {
          handled: true,
          source: catalogSource || "catalog_route",
          intent: catalogIntent,
          reply: rawCatalogText,
          ctxPatch: finalCtxPatch || {},
          awaitingEffect: catalogAwaitingEffect,
        },
        detectedIntent: catalogIntent,
        intentFallback: catalogIntent,
        detectedCommercial,
        catalogRoutingSignal: params.catalogReferenceClassification ?? null,
        catalogReferenceClassification: params.catalogReferenceClassification ?? null,
        structuredService: {
          serviceId:
            catalogPayload?.kind === "resolved_catalog_answer"
              ? catalogPayload.serviceId || null
              : catalogPayload?.kind === "variant_choice"
              ? catalogPayload.serviceId || null
              : null,
          serviceName:
            catalogPayload?.kind === "resolved_catalog_answer"
              ? catalogPayload.serviceName || null
              : catalogPayload?.kind === "variant_choice"
              ? catalogPayload.serviceName || null
              : null,
          serviceLabel:
            catalogPayload?.kind === "resolved_catalog_answer"
              ? catalogPayload.variantName || catalogPayload.serviceName || null
              : catalogPayload?.kind === "variant_choice"
              ? catalogPayload.serviceName || null
              : null,
          hasResolution:
            catalogPayload?.kind === "resolved_catalog_answer" &&
            (
              Boolean(catalogPayload.serviceId) ||
              Boolean(catalogPayload.variantId)
            ),
        },
        ctxPatch: finalCtxPatch || {},
      }),
      ctxPatch: finalCtxPatch || {},
      maxLines: MAX_WHATSAPP_LINES,
    });

    if (rendered.ctxPatch) {
      transition({ patchCtx: rendered.ctxPatch });
      finalCtxPatch = {
        ...finalCtxPatch,
        ...rendered.ctxPatch,
      };
    }

    const finalCatalogText = await ensureReplyLanguage(
      String(rendered.reply || "").trim(),
      idiomaDestino
    );

    if (!finalCatalogText) {
      return false;
    }

    INTENCION_FINAL_CANONICA =
      catalogIntent || INTENCION_FINAL_CANONICA || null;

    lastIntent =
      catalogIntent || lastIntent || null;

    await replyAndExit(
      finalCatalogText,
      catalogSource || "catalog_route",
      catalogIntent || null
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
  detectedFacets           = signals.detectedFacets || null;
  detectedCommercial       = signals.detectedCommercial || null;
  INTENCION_FINAL_CANONICA = signals.INTENCION_FINAL_CANONICA;
  promptBaseMem            = signals.promptBaseMem;
  convoCtx = {
    ...(convoCtx || {}),
    ...(signals.convoCtx || {}),
  };

  // ✅ Segunda pasada canónica de idioma con el contexto ya hidratado.
  // whatsapp.ts sigue siendo dispatcher: no interpreta semántica,
  // solo vuelve a pedir la resolución oficial con mejor contexto.
  {
    const langOutAfterSignals = await resolveLangForTurn({
      pool,
      tenant,
      canal,
      contactoNorm,
      userInput,
      convoCtx,
      tenantBase,
      forcedLangThisTurn: null,
    });

    const nextIdiomaDestino = langOutAfterSignals.idiomaDestino;

    if (nextIdiomaDestino !== idiomaDestino) {
      idiomaDestino = nextIdiomaDestino;
      promptBase = langOutAfterSignals.promptBase;
      promptBaseMem = langOutAfterSignals.promptBaseMem;

      convoCtx = {
        ...(convoCtx || {}),
        ...(langOutAfterSignals.convoCtx || {}),
      };
    }
  }

  let hasPendingCta = hasPendingCtaAwaitingConfirmation(convoCtx);

  if (hasPendingCta) {
    console.log("[WHATSAPP][PENDING_CTA_AWAITING_GATE]", {
      tenantId: tenant.id,
      canal,
      contactoNorm,
      userInput,
      pendingCta: (convoCtx as any)?.pending_cta ?? null,
    });
  }

  const currentResolvedIntent = String(
    INTENCION_FINAL_CANONICA || detectedIntent || ""
  )
    .trim()
    .toLowerCase() || null;

  const shouldHoldTurnForPendingCta =
    hasPendingCta &&
    shouldTreatTurnAsPendingCtaConfirmation({
      userInput,
      resolvedIntent: currentResolvedIntent,
    });

  if (hasPendingCta && !shouldHoldTurnForPendingCta) {
    console.log("[WHATSAPP][PENDING_CTA_RELEASED_FOR_NEW_QUESTION]", {
      tenantId: tenant.id,
      canal,
      contactoNorm,
      userInput,
      currentResolvedIntent,
      pendingCta: (convoCtx as any)?.pending_cta ?? null,
    });

    const clearPendingCtaPatch = {
      pending_cta: null,
      awaiting_yes_no_action: null,
      awaiting_yesno: false,
      yesno_resolution: null,
    };

    transition({ patchCtx: clearPendingCtaPatch });

    finalCtxPatch = {
      ...finalCtxPatch,
      ...clearPendingCtaPatch,
    };

    hasPendingCta = false;
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

      (convoCtx as any).pendingCatalogChoice = null;
      (convoCtx as any).pendingCatalogChoiceAt = null;

      (convoCtx as any).lastPresentedEntityIds = null;
      (convoCtx as any).lastPresentedFamilyKeys = null;

      (convoCtx as any).expectingVariantForEntityId = null;
      (convoCtx as any).expectedVariantIntent = null;

      (convoCtx as any).presentedVariantOptions = null;
      (convoCtx as any).last_variant_options = null;
      (convoCtx as any).last_variant_options_at = null;

      (convoCtx as any).continuationContext = null;
      (convoCtx as any).last_assistant_turn = null;

      finalCtxPatch = {
        ...finalCtxPatch,
        expectingVariant: false,
        selectedServiceId: null,
        last_plan_list: null,
        last_plan_list_at: null,
        last_package_list: null,
        last_package_list_at: null,
        last_list_kind: null,
        last_list_kind_at: null,
        pending_link_lookup: null,
        pending_link_at: null,
        pending_link_options: null,
        last_service_id: null,
        last_service_name: null,
        last_service_label: null,
        last_entity_kind: null,
        last_entity_at: null,
        structuredService: null,
        pendingCatalogChoice: null,
        pendingCatalogChoiceAt: null,
        lastPresentedEntityIds: null,
        lastPresentedFamilyKeys: null,
        expectingVariantForEntityId: null,
        expectedVariantIntent: null,
        presentedVariantOptions: null,
        last_variant_options: null,
        last_variant_options_at: null,
        continuationContext: null,
        last_assistant_turn: null,
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
  // ⚡ DOMAIN ROUTER
  // handleFastpathHybridTurn SOLO decide dominio
  // ===============================
  if (!inBooking0 && !hasPendingCta) {
    const convoCtxForHybrid = convoCtx || {};

    const hybridRes = await handleFastpathHybridTurn({
      pool,
      tenantId: tenant.id,
      canal,
      idiomaDestino,
      userInput,
      inBooking: Boolean(inBooking0),
      convoCtx: convoCtxForHybrid,
      infoClave: String(tenant?.info_clave || ""),
      detectedIntent: signals?.detectedIntent || detectedIntent || null,
      detectedFacets:
        (signals as any)?.detectedFacets ||
        (signals as any)?.facets ||
        detectedFacets ||
        {},
      detectedCommercial,
      detectedRoutingHints: (signals as any)?.detectedRoutingHints || null,
      intentFallback:
        signals?.INTENCION_FINAL_CANONICA || INTENCION_FINAL_CANONICA || null,
      messageId: messageId || null,
      contactoNorm,
      promptBaseMem: signals?.promptBaseMem || promptBaseMem,
      referentialFollowup: signals?.referentialFollowup === true,
      followupNeedsAnchor: signals?.followupNeedsAnchor === true,
      followupEntityKind: signals?.followupEntityKind || null,
      turnAugmentation,
    });

    if (hybridRes.ctxPatch) {
      transition({ patchCtx: hybridRes.ctxPatch });
      finalCtxPatch = { ...finalCtxPatch, ...hybridRes.ctxPatch };
    }

    const nextIntent =
      hybridRes.intent ||
      signals?.INTENCION_FINAL_CANONICA ||
      INTENCION_FINAL_CANONICA ||
      signals?.detectedIntent ||
      detectedIntent ||
      null;

    const nextDetectedFacets =
      (signals as any)?.detectedFacets ||
      (signals as any)?.facets ||
      detectedFacets ||
      null;

    const shouldUseGuidedEntryOutsideFastpath =
      shouldUseGuidedBusinessEntryOutsideFastpath({
        routeTarget: hybridRes.routeTarget,
        detectedIntent: signals?.detectedIntent || detectedIntent || null,
        intentFallback:
          signals?.INTENCION_FINAL_CANONICA || INTENCION_FINAL_CANONICA || null,
        detectedFacets: nextDetectedFacets,
        detectedCommercial,
      });

    if (hybridRes.routeTarget === "catalog") {
      const catalogReferenceClassification =
        hybridRes.routeContext?.catalogReferenceClassification ||
        (signals as any)?.catalogReferenceClassification ||
        undefined;

      const canonicalCatalogResolution =
        hybridRes.routeContext?.canonicalCatalogResolution || undefined;

      const handledCatalog = await tryCatalogOutsideHybridDecision({
        intent: nextIntent,
        detectedFacets: nextDetectedFacets,
        convoCtxForCatalog: convoCtx,
        catalogReferenceClassification,
        canonicalCatalogResolution,
      });

      if (handledCatalog) {
        return;
      }

      const isAmbiguousCatalogFamilyTurn =
        canonicalCatalogResolution?.resolutionKind === "ambiguous" &&
        (
          catalogReferenceClassification?.kind === "catalog_family" ||
          catalogReferenceClassification?.targetLevel === "family" ||
          catalogReferenceClassification?.targetLevel === "multi_service" ||
          catalogReferenceClassification?.routeIntent === "catalog_family"
        );

      if (isAmbiguousCatalogFamilyTurn) {
        console.log("[WHATSAPP][AMBIGUOUS_CATALOG_FAMILY_DEFERRED]", {
          tenantId: tenant.id,
          canal,
          contactoNorm,
          userInput,
          detectedIntent: nextIntent,
          canonicalCatalogResolutionKind:
            canonicalCatalogResolution?.resolutionKind || null,
        });
      }
    }

    if (
      hybridRes.routeTarget === "business_info" ||
      shouldUseGuidedEntryOutsideFastpath
    ) {
      const handledExternalAction =
        await tryExternalActionContextContinuation({
          intent: nextIntent,
          detectedFacets: nextDetectedFacets,
        });

      if (handledExternalAction) {
        return;
      }


      const handledBusinessInfo = await tryBusinessInfoOutsideFastpath({
        intent: nextIntent,
        detectedFacets: nextDetectedFacets,
        overviewMode: shouldUseGuidedEntryOutsideFastpath
          ? "guided_entry"
          : "general_overview",
      });

      if (handledBusinessInfo) {
        return;
      }
    }

    if (
      hybridRes.routeTarget === "continue_pipeline" &&
      !shouldUseGuidedEntryOutsideFastpath
    ) {
      console.log("[WHATSAPP][CONTINUE_PIPELINE_NO_AUTO_COMPOSE]", {
        tenantId: tenant.id,
        canal,
        contactoNorm,
        userInput,
        detectedIntent: nextIntent,
        canonicalCatalogResolutionKind:
          hybridRes.routeContext?.canonicalCatalogResolution?.resolutionKind || null,
      });
    }
  } else {
    console.log("🔒 DOMAIN ROUTER SKIPPED", {
      bookingStep0,
      hasPendingCta,
      reason: inBooking0
        ? "booking_activo"
        : "pending_cta_awaiting_confirmation",
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

    const fallback = await resolveUnhandledTurnFallback({
      tenantId: tenant.id,
      canal,
      idiomaDestino,
      userInput,
      contactoNorm,
      messageId: messageId || null,
      promptBaseMem,
      infoClave: String(tenant?.info_clave || ""),
      detectedIntent: detectedIntent || null,
      intentFallback: INTENCION_FINAL_CANONICA || null,
      detectedFacets: detectedFacets || null,
      detectedCommercial: detectedCommercial || null,
      ctxPatch: finalCtxPatch || {},

      conversationState: {
        activeFlow,
        activeStep,
      },

      fallbackKind:
        activeFlow === "estimate_flow" &&
        activeStep === "scheduled" &&
        (
          INTENCION_FINAL_CANONICA === "saludo" ||
          detectedIntent === "saludo"
        )
          ? "post_completion_courtesy"
          : "default",
    });

    if (fallback.ctxPatch) {
      transition({ patchCtx: fallback.ctxPatch });
      finalCtxPatch = {
        ...finalCtxPatch,
        ...fallback.ctxPatch,
      };
    }

    return await replyAndExit(
      fallback.reply,
      fallback.source,
      fallback.intent || null
    );
  }
}