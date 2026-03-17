// src/routes/facebook/webhook.ts
//
// ✅ Objetivo: que FB/IG use el MISMO pipeline “engine” que WhatsApp
// (lang resolution + user signals + booking + fastpath + state machine + fallback + finalizeReply + postReplyActions)
//
// Nota: aquí conservamos:
// - Verificación GET de Meta
// - Resolución tenant por pageId (facebook_page_id / instagram_page_id)
// - Gates de subcanal + canUseChannel + membresía
// - Dedupe inbound (interactions) + dedupe corto en memoria
// Y reemplazamos el resto por la misma lógica del webhook de WhatsApp.

import express from "express";
import pool from "../../lib/db";

import type { Canal } from "../../lib/detectarIntencion";
import type { Lang } from "../../lib/channels/engine/clients/clientDb";

import crypto from "crypto";

import { requireChannel } from "../../middleware/requireChannel";
import { canUseChannel } from "../../lib/features";

import { antiPhishingGuard } from "../../lib/security/antiPhishing";
import { saludoPuroRegex } from "../../lib/saludosConversacionales";
import { incrementarUsoPorCanal } from "../../lib/incrementUsage";
import { enviarMensajePorPartes } from "../../lib/enviarMensajePorPartes";

import {
  setConversationState as setConversationStateDB,
  getOrInitConversationState,
} from "../../lib/conversationState";
import { finalizeReply as finalizeReplyLib } from "../../lib/conversation/finalizeReply";
import { runPostReplyActions } from "../../lib/conversation/postReplyActions";

import { createStateMachine } from "../../lib/conversation/stateMachine";
import { paymentHumanGate } from "../../lib/guards/paymentHumanGuard";
import { yesNoStateGate } from "../../lib/guards/yesNoStateGate";
import { awaitingGate } from "../../lib/guards/awaitingGate";
import { humanOverrideGate } from "../../lib/guards/humanOverrideGate";

import { resolveLangForTurn } from "../../lib/channels/engine/lang/resolveLangForTurn";
import {
  normalizeLang,
  ensureClienteBase,
  upsertIdiomaClienteDB,
  getSelectedChannelDB,
  upsertSelectedChannelDB,
} from "../../lib/channels/engine/clients/clientDb";

import { handleFastpathHybridTurn } from "../../lib/channels/engine/fastpath/handleFastpathHybridTurn";
import { handleStateMachineTurn } from "../../lib/channels/engine/sm/handleStateMachineTurn";
import { handleUserSignalsTurn } from "../../lib/channels/engine/turn/handleUserSignalsTurn";
import { handleBookingTurn } from "../../lib/channels/engine/booking/handleBookingTurn";

import { postBookingCourtesyGuard } from "../../lib/appointments/booking/postBookingCourtesyGuard";
import { rememberAfterReply } from "../../lib/memory/rememberAfterReply";

import { safeSendText } from "../../lib/channels/engine/dedupe/safeSendText";
import {
  looksLikeBookingPayload,
  pickSelectedChannelFromText,
} from "../../lib/channels/engine/parsers/parsers";
import { parseDatosCliente } from "../../lib/parseDatosCliente";

import { runEstimateFlowTurn } from "../../lib/estimateFlow/runEstimateFlowTurn";
import { detectarIdioma } from "../../lib/detectarIdioma";
import { traducirMensaje } from "../../lib/traducirMensaje";
import { getMemoryValue } from "../../lib/clientMemory";
import {
  resolveServiceCandidatesFromText,
} from "../../lib/services/pricing/resolveServiceIdFromText";
import {
  cancelPendingFollowUps,
} from "../../lib/followups/followUpScheduler";

type CanalEnvio = "facebook" | "instagram";

const router = express.Router();

const GLOBAL_ID =
  process.env.GLOBAL_CHANNEL_TENANT_ID ||
  "00000000-0000-0000-0000-000000000001"; // fallback seguro

// 🛡️ Cache en memoria para dedupe de inbound (texto+contacto+tenant)
const inboundDedupCache = new Map<string, number>();

const sha256 = (s: string) =>
  crypto
    .createHash("sha256")
    .update(String(s || "").trim().toLowerCase())
    .digest("hex");

// ===============================
// Meta channel gates (mantener)
// ===============================
async function isMetaSubChannelEnabled(
  tenantId: string,
  canalEnvio: CanalEnvio
): Promise<boolean> {
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
// STATE MACHINE (mismo stack WA)
// ===============================
const sm = createStateMachine([
  humanOverrideGate,
  paymentHumanGate,
  yesNoStateGate,
  awaitingGate,
]);

const MAX_LINES_META = 9999;

// ===============================
// Meta send wrapper -> compatible con safeSendText
// ===============================
async function enviarMetaAsSendFn(
  tenantId: string,
  to: string,
  text: string,
  meta: {
    canalEnvio: CanalEnvio;
    accessToken: string;
    messageId: string;
  }
) {
  // enviarMensajePorPartes ya corta si hace falta (como WhatsApp)
  await enviarMensajePorPartes({
    respuesta: text,
    senderId: to,
    tenantId,
    canal: meta.canalEnvio as any,
    messageId: meta.messageId,
    accessToken: meta.accessToken,
  });
}

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
// POST Meta (Facebook / Instagram)
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

        // Evita eco propio (senderId == pageId) y eventos echo
        if (String(senderId) === String(pageId)) continue;
        if (isEcho) continue;

        const messageId: string = messagingEvent.message.mid;
        const userInput: string = messagingEvent.message.text || "";

        if (!messageId || !senderId) continue;

        // Procesamos en async “en línea” (ya respondimos 200)
        // Si prefieres aislar por evento, puedes envolver en try/catch interno.
        await procesarMensajeMeta({
          pageId,
          senderId,
          messageId,
          userInput,
          object: String(body.object || ""),
        });
      }
    }
  } catch (error: any) {
    console.error("❌ Error en webhook Meta:", error);
  }
});

export default router;

// ===============================
// Pipeline “igual WhatsApp”
// ===============================
async function procesarMensajeMeta(args: {
  pageId: string;
  senderId: string; // PSID / IGSID
  messageId: string;
  userInput: string;
  object: string; // "page" | "instagram"
}) {
  const { pageId, senderId, messageId, userInput } = args;

  // ===============================
  // Resolver tenant por pageId + cargar meta_configs (igual que antes)
  // ===============================
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
  if (!rows.length) return;

  const tenant = rows[0];
  const tenantId: string = tenant.id;

  const isInstagram =
    tenant.instagram_page_id && String(tenant.instagram_page_id) === String(pageId);
  const canalEnvio: CanalEnvio = isInstagram ? "instagram" : "facebook";
  const canal: Canal = canalEnvio as any;

  const accessToken = String(tenant.facebook_access_token || "");
  if (!accessToken) {
    console.warn("⚠️ [META] tenant sin facebook_access_token:", { tenantId });
    return;
  }

  // ===============================
  // Gates (subcanal + plan + membresía)
  // ===============================
  const subEnabled = await isMetaSubChannelEnabled(tenantId, canalEnvio);
  if (!subEnabled) return;

  try {
    const gate = await canUseChannel(tenantId, "meta");
    if (!gate.plan_enabled) return;
    if (gate.reason === "paused") return;
  } catch (e) {
    console.warn("⚠️ [META] canUseChannel falló; bloqueo por seguridad:", e);
    return;
  }

  // Membresía activa (mismo criterio que venías usando)
  const estaActiva =
    tenant.membresia_activa === true ||
    tenant.membresia_activa === "true" ||
    tenant.membresia_activa === 1;

  if (!estaActiva) return;

  // ===============================
  // 🛡️ DEDUPE inbound (memoria corto) + (DB interactions) como WA
  // ===============================
  {
    const text = String(userInput || "").trim();
    const contactKey = String(senderId || "").trim();

    if (tenantId && text && contactKey) {
      const normalize = (s: string) =>
        String(s || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();

      const normText = normalize(text);
      const key = `${tenantId}:${canalEnvio}:${contactKey}:${normText}`;

      const now = Date.now();
      const ttlMs = 15_000;

      const last = inboundDedupCache.get(key);
      if (typeof last === "number" && now - last >= 0 && now - last < ttlMs) {
        console.log("🚫 [META] inbound dedupe (mem): omit", { key, diffMs: now - last });
        return;
      }
      inboundDedupCache.set(key, now);
    }
  }

  {
    const r = await pool.query(
      `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (tenant_id, canal, message_id) DO NOTHING
       RETURNING 1`,
      [tenantId, canalEnvio, messageId]
    );

    if ((r.rowCount ?? 0) === 0) {
      console.log("⏩ [META] inbound dedupe (DB): ya procesado", {
        tenantId,
        canalEnvio,
        messageId,
      });
      return;
    }
  }

  // ===============================
  // ✅ Cliente base (igual WA)
  // ===============================
  const contactoNorm = senderId; // aquí es PSID/IGSID
  const fromNumber = senderId;

  const isNewLead = await ensureClienteBase(pool, tenantId, canal, contactoNorm);

  // ✅ FOLLOW-UP RESET: si el cliente volvió a escribir, cancela cualquier follow-up pendiente
  try {
    const deleted = await cancelPendingFollowUps({
      tenantId,
      canal: canal as any,
      contacto: contactoNorm,
    });

    if (deleted > 0) {
      console.log("🧹 [META] follow-ups pendientes cancelados por nuevo inbound:", {
        tenantId,
        canal,
        contacto: contactoNorm,
        deleted,
        messageId,
      });
    }
  } catch (e: any) {
    console.warn("⚠️ [META] cancelPendingFollowUps failed:", e?.message);
  }

  // ===============================
  // 🌍 Idioma: mismo motor WA (resolveLangForTurn)
  // - Forzamos tenantBase (fallback)
  // - forcedLangThisTurn: null (Meta no tiene “hello->en” hardcode aquí; lo maneja detectarIdioma/resolveLangForTurn)
  // ===============================
  const tenantBase: Lang = normalizeLang(tenant?.idioma || "es");
  let idiomaDestino: Lang = tenantBase;
  let forcedLangThisTurn: Lang | null = null;

  // ✅ FORZAR IDIOMA SOLO en saludo inicial claro (igual WA)
  try {
    const t0 = String(userInput || "").trim().toLowerCase();
    const isClearHello = /^(hello|hi|hey)\b/i.test(t0);
    const isClearHola = /^(hola|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches)\b/i.test(t0);

    let forcedLang: Lang | null = null;

    if (isClearHello) forcedLang = "en";
    else if (isClearHola) forcedLang = "es";

    if (forcedLang) {
      await upsertIdiomaClienteDB(pool, tenantId, canal, contactoNorm, forcedLang);
      idiomaDestino = forcedLang;
      forcedLangThisTurn = forcedLang;

      console.log("🌍 [META] LANG FORCED (clear greeting) =", {
        isNewLead,
        userInput,
        forcedLang,
        idiomaDestino,
      });
    }
  } catch (e: any) {
    console.error("❌ [META] LANG FORCED ERROR:", e?.message || e);
  }

  // ===============================
  // 🧠 conversation_state (igual WA)
  // ===============================
  const st = await getOrInitConversationState({
    tenantId,
    canal,
    senderId: contactoNorm,
    defaultFlow: "generic_sales",
    defaultStep: "start",
  });

  let activeFlow = st.active_flow || "generic_sales";
  let activeStep = st.active_step || "start";
  let convoCtx = st.context && typeof st.context === "object" ? st.context : {};

  const convoCtxBeforeLang = convoCtx;

  // 🔍 MEMORIA – inicio del turno (igual WA)
  const memStart = await getMemoryValue<string>({
    tenantId,
    canal,
    senderId: contactoNorm,
    key: "facts_summary",
  });

  console.log("🧠 [META] facts_summary (start of turn) =", memStart);

  // Prompt base: en meta priorizamos meta_configs si existe; si no, prompt por canal
  // OJO: resolveLangForTurn construye promptBase usando getPromptPorCanal internamente,
  // pero aquí queremos respetar prompt_meta si existe.
  // Strategy:
  // 1) dejamos que resolveLangForTurn resuelva idioma + promptBase (genérico),
  // 2) luego “override” promptBase con prompt_meta si aplica, y reconstruimos promptBaseMem.
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

  // prompt base resultante del motor
  let promptBase = langOut.promptBase;
  let promptBaseMem = langOut.promptBaseMem;

  // merge ctx para no perder last_catalog_* etc
  convoCtx = {
    ...(convoCtxBeforeLang || {}),
    ...(langOut.convoCtx || {}),
  };

  console.log("🌍 [META] LANG DEBUG =", {
    userInput,
    tenantBase,
    storedLang: langOut.storedLang,
    detectedLang: langOut.langRes?.detectedLang,
    lockedLang: langOut.langRes?.lockedLang,
    inBookingLang: langOut.langRes?.inBookingLang,
    idiomaDestino,
  });

  // ✅ Override prompt/bienvenida por meta_configs si existen
  const promptMeta =
    tenant.prompt_meta && String(tenant.prompt_meta).trim()
      ? String(tenant.prompt_meta).trim()
      : null;

  const bienvenidaMeta =
    tenant.bienvenida_meta && String(tenant.bienvenida_meta).trim()
      ? String(tenant.bienvenida_meta).trim()
      : null;

  if (promptMeta) {
    // Mantén memoria que ya venía en promptBaseMem si existía (facts_summary etc)
    // Re-armamos de manera segura:
    const memMarker = "\n\nMEMORIA_DEL_CLIENTE";
    const idx = String(promptBaseMem || "").indexOf(memMarker);
    const memTail = idx >= 0 ? String(promptBaseMem || "").slice(idx) : "";
    promptBase = promptMeta;
    promptBaseMem = [promptMeta, memTail].filter(Boolean).join("\n");
  }

  const bienvenida =
    bienvenidaMeta ||
    (await (async () => {
      // usa tu helper estándar por canal
      // (WA usa getBienvenidaPorCanal; resolveLangForTurn ya sabe el idioma)
      const { getBienvenidaPorCanal } = await import("../../lib/getPromptPorCanal");
      return getBienvenidaPorCanal(canalEnvio as any, tenant, idiomaDestino);
    })());

  // ===============================
  // 🔁 Helpers (igual WA)
  // ===============================
  function transition(params: { flow?: string; step?: string; patchCtx?: any }) {
    if (params.flow !== undefined) activeFlow = params.flow;
    if (params.step !== undefined) activeStep = params.step;
    if (params.patchCtx && typeof params.patchCtx === "object") {
      convoCtx = { ...(convoCtx || {}), ...params.patchCtx };
    }
  }

  // google_calendar_enabled flag (source of truth)
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

  // Single-exit variables
  let handled = false;
  let reply: string | null = null;
  let replySource: string | null = null;
  let lastIntent: string | null = null;
  let INTENCION_FINAL_CANONICA: string | null = null;

  let detectedIntent: string | null = null;
  let detectedInterest: number | null = null;

  let replied = false;

  function setReply(text: string, source: string, intent?: string | null) {
    replied = true;
    handled = true;
    reply = text;
    replySource = source;
    if (intent !== undefined) lastIntent = intent;
  }

  async function ensureReplyLanguage(text: string, targetLang: Lang): Promise<string> {
    const raw = String(text || "").trim();
    if (!raw) return raw;

    try {
      const detected = await detectarIdioma(raw);
      const outLang = detected?.lang;

      // Si no se pudo detectar, no tocamos
      if (outLang !== "es" && outLang !== "en") {
        return raw;
      }

      // Ya está en el idioma correcto
      if (outLang === targetLang) {
        return raw;
      }

      // Traducir al idioma del turno
      const translated = await traducirMensaje(raw, targetLang);
      return String(translated || raw).trim() || raw;
    } catch (e: any) {
      console.warn("⚠️ [META] ensureReplyLanguage failed:", e?.message || e);
      return raw;
    }
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

  // ✅ safeSend “engine-style” (igual WA) usando safeSendText
  // OJO: safeSendText dedupe + usage. Nosotros le pasamos un “send” que llama a Meta.
  const safeSend = (tId: string, c: string, mId: string | null, to: string, text: string) =>
    safeSendText({
      pool,
      tenantId: tId,
      canal: canalEnvio, 
      messageId: mId,
      to,
      text,
      send: async (to: string, text: string, tenantId2: string) => {
        await enviarMetaAsSendFn(tenantId2, to, text, {
          canalEnvio,
          accessToken,
          messageId: `out_${tenantId2}_${canalEnvio}_${Date.now()}`
        });

        return true; // ← IMPORTANTE
      },
      incrementUsage: incrementarUsoPorCanal,
    });

  async function finalizeReply() {
    await finalizeReplyLib(
      {
        handled,
        reply,
        replySource,
        lastIntent,

        tenantId,
        canal: canalEnvio as any,
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
          convoCtx = nextCtx;
        },
      },
      {
        safeSend,
        setConversationState: setConversationStateCompat,
        saveAssistantMessageAndEmit: async (opts: any) => {
          const { saveAssistantMessageAndEmit } = await import(
            "../../lib/channels/engine/messages/saveAssistantMessageAndEmit"
          );
          return saveAssistantMessageAndEmit({
            ...opts,
            canal,
            fromNumber: contactoNorm,
            intent: lastIntent || INTENCION_FINAL_CANONICA || null,
            interest_level: typeof detectedInterest === "number" ? detectedInterest : null,
          });
        },
        rememberAfterReply: (args: any) =>
          rememberAfterReply({
            ...args,
            canal: canalEnvio as any,
            replySource: args?.replySource ?? args?.source ?? null,
          }),
      }
    );

    // ✅ Igual WA: post reply actions (followups, sales intelligence, CAPI, etc.)
    try {
      if (!handled || !reply) return;

      // 🔒 NO post-actions (followups/CAPI/etc) cuando es soporte/handoff
      if ((convoCtx as any)?.__no_followups || replySource === "support_handoff") {
        return;
      }

      await runPostReplyActions({
        pool,
        tenant,
        tenantId,
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
      console.warn("⚠️ [META] runPostReplyActions failed:", e?.message);
    }
  }

  async function replyAndExit(text: string, source: string, intent?: string | null) {
    const finalText = await ensureReplyLanguage(text, idiomaDestino);
    setReply(finalText, source, intent);
    await finalizeReply();
    return;
  }

  // ===============================
  // 👋 Greeting gate (igual WA)
  // ===============================
  const bookingStep0 = (convoCtx as any)?.booking?.step;
  let inBooking0 = !!(bookingStep0 && bookingStep0 !== "idle");

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
    return;
  }

  // ===============================
  // 📅 BOOKING helper (mismo módulo WA)
  // ===============================
  async function tryBooking(mode: "gate" | "guardrail", tag: string) {
    const bookingRes = await handleBookingTurn({
      pool,
      tenantId,
      canal,
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

      persistState: async (nextCtx) => {
        await setConversationStateCompat(tenantId, canal, contactoNorm, {
          activeFlow,
          activeStep,
          context: nextCtx,
        });
        convoCtx = nextCtx;
      },
    });

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

  // ===============================
  // 🔔 USER SIGNALS (igual WA)
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
    promptBase,
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
      await pool.query(
        `UPDATE clientes
        SET estado = NULL
        WHERE tenant_id = $1
        AND canal = $2
        AND contacto = $3
        AND estado = 'esperando_pago'`,
        [tenant.id, canal, contactoNorm]
      );
    }
  } catch (e: any) {
    console.warn("⚠️ reset estado pago failed:", e?.message);
  }

  detectedIntent = signals.detectedIntent;
  detectedInterest = signals.detectedInterest;
  INTENCION_FINAL_CANONICA = signals.INTENCION_FINAL_CANONICA;
  promptBaseMem = signals.promptBaseMem;
  convoCtx = {
    ...(convoCtx || {}),
    ...(signals.convoCtx || {}),
  };

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
        tenantId,
        canal,
        contactoNorm,
        pendingCtaType,
        userInput,
      });

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
        tenantId,
        canal,
        contactoNorm,
        pendingCtaType,
        userInput,
      });

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

  const BOOKING_INTENTS = new Set<string>([
    "booking_start",
    "booking_date",
    "booking_time",
    "booking_confirm",
    "booking_change",
    "booking_horarios",
  ]);

  const INFO_HORARIOS_INTENTS = new Set<string>([
    "info_horarios_generales",
  ]);

  let bookingStepNow = (convoCtx as any)?.booking?.step;
  let inBookingNow = !!(bookingStepNow && bookingStepNow !== "idle");

  if (inBookingNow) {
    if (intentNow && INFO_HORARIOS_INTENTS.has(intentNow)) {
      console.log("🔓 [META] booking: se permite fastpath para info_horarios_generales", {
        bookingStepNow,
        intentNow,
      });
      inBookingNow = false;
    } else if (intentNow && !BOOKING_INTENTS.has(intentNow)) {
      console.log("🔓 [META] booking: lock liberado porque intent no es de booking", {
        bookingStepNow,
        intentNow,
      });
      inBookingNow = false;

      if ((convoCtx as any)?.booking) {
        (convoCtx as any).booking = {
          ...(convoCtx as any).booking,
          step: "idle",
        };
      }
    }
  }

  // 🔴 HARD STOP: soporte/handoff marcó detener pipeline
  if ((convoCtx as any)?.__stop_pipeline) {
    // si por alguna razón no envió reply todavía, lo enviamos
    if (signals.handled && signals.humanOverrideReply) {
      await replyAndExit(
        signals.humanOverrideReply,
        signals.humanOverrideSource || "support_handoff",
        detectedIntent
      );
      return;
    }

    // si no hay reply, igual NO seguimos (evita LLM/followups por error)
    return;
  }

  // Si el helper ya manejó el turno (override explícito), salimos
  if (signals.handled && signals.humanOverrideReply) {
    await replyAndExit(
      signals.humanOverrideReply,
      signals.humanOverrideSource || "human_override_explicit",
      detectedIntent
    );
    return;
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
  // ✅ POST-BOOKING COURTESY GUARD (igual WA)
  // ===============================
  {
    const c = postBookingCourtesyGuard({ ctx: convoCtx, userInput, idioma: idiomaDestino });
    if (c.hit) {
      await replyAndExit(c.reply, "post_booking_courtesy", "cortesia");
      return;
    }
  }

  // ===============================
  // ⚡ FASTPATH (igual WA)
  // ===============================
  inBooking0 = !!((convoCtx as any)?.booking?.step && (convoCtx as any)?.booking?.step !== "idle");
  if (!inBooking0) {
    const fpRes = await handleFastpathHybridTurn({
      pool,
      tenantId,
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

    if (fpRes.ctxPatch) transition({ patchCtx: fpRes.ctxPatch });

    if (fpRes.handled && fpRes.reply) {
      if (fpRes.intent) {
        INTENCION_FINAL_CANONICA = fpRes.intent;
        lastIntent = fpRes.intent;
      }

      await replyAndExit(fpRes.reply, fpRes.replySource || "fastpath_hybrid", fpRes.intent || null);
      return;
    }
  }

  // ===============================
  // 🤖 STATE MACHINE TURN (igual WA)
  // ===============================
  inBooking0 = !!((convoCtx as any)?.booking?.step && (convoCtx as any)?.booking?.step !== "idle");
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
      promptBase,
      promptBaseMem,
      MAX_LINES: MAX_LINES_META,
      tryBooking,
      tenantId,
      eventUserInput: userInput,
      replyAndExit,
      parseDatosCliente,
      extractPaymentLinkFromPrompt: null,
      PAGO_CONFIRM_REGEX: null,
    });

    if (smHandled) {
      // ✅ Evita que Meta se quede pegado en generic_sales/start repitiendo el overview
      if (activeFlow === "generic_sales" && activeStep === "start") {
        await setConversationStateCompat(tenantId, canal, contactoNorm, {
          activeFlow,
          activeStep: "answer",          // o "close" si tu SM usa eso
          context: convoCtx,
        });
        activeStep = "answer";
      }
      return;
    }
  }

  // ===============================
  // 🛡️ Anti-phishing (igual WA)
  // ===============================
  {
    let phishingReply: string | null = null;

    const handledPhishing = await antiPhishingGuard({
      pool,
      tenantId,
      channel: canalEnvio as any,
      senderId: contactoNorm,
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
      return;
    }
  }

  // ===============================
  // ✅ CANAL ELEGIDO (igual WA)
  // ===============================
  {
    const selectedChannel = await getSelectedChannelDB(pool, tenantId, canal, contactoNorm);
    const hasSelected = !!selectedChannel;

    if (!hasSelected) {
      const picked = pickSelectedChannelFromText(userInput);
      if (picked) {
        await upsertSelectedChannelDB(pool, tenantId, canal, contactoNorm, picked);
      }
    }
  }

  // ===============================
  // ✅ FALLBACK ÚNICO (igual WA)
  // ===============================
  if (!replied) {
    if (await tryBooking("guardrail", "sm_fallback")) return;

    // Reglas WA equivalentes (Meta también)
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
            "- If the user also asks about schedules/hours, answer hours in 1 short sentence and then show the prices as a bullet list.",
          ].join(" ")
        : [
            "REGLA: Si tu respuesta menciona precios o planes tomados de DATOS_ESTRUCTURADOS_DEL_SISTEMA, DEBES formatearlos como lista con viñetas.",
            "- Puedes empezar con 0–1 línea muy corta de introducción (por ejemplo: 'Los precios principales son:').",
            "- Luego usa UNA línea por opción, por ejemplo: '• Plan Gold Autopay: $165.99/mes – beneficio breve'.",
            "- NUNCA metas varios precios o planes distintos en un solo párrafo largo.",
            "- Si el usuario también pregunta por horarios, responde los horarios en 1 frase corta y después muestra los precios como lista con viñetas.",
          ].join(" ");

    // Historial (reutiliza helper WA real)
    const { getRecentHistoryForModel } = await import(
      "../../lib/channels/engine/messages/getRecentHistoryForModel"
    );

    const history = await getRecentHistoryForModel({
      tenantId,
      canal,
      fromNumber: contactoNorm,
      excludeMessageId: messageId,
      limit: 12,
    });

    const { answerWithPromptBase } = await import("../../lib/answers/answerWithPromptBase");

    const structuredService =
      (convoCtx as any)?.structuredService ?? null;

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

    console.log("[META][SM_FALLBACK][STRUCTURED_SERVICE]", {
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
        tenantId,
        userInput,
        { mode: "loose" }
      );

      if (resolved.ambiguous && resolved.candidates.length >= 2) {
        const MAX_OPTIONS = 4;
        const topCandidates = resolved.candidates.slice(0, MAX_OPTIONS);

        const { rows: detailRows } = await pool.query<{
          id: string;
          name: string | null;
          description: string | null;
          variant_name: string | null;
          variant_description: string | null;
        }>(
          `
          SELECT
            s.id,
            s.name,
            s.description,
            v.variant_name,
            v.description AS variant_description
          FROM services s
          LEFT JOIN service_variants v
            ON v.service_id = s.id
           AND v.active = true
          WHERE s.tenant_id = $1
            AND s.id = ANY($2::uuid[])
          ORDER BY s.created_at ASC, v.created_at ASC NULLS LAST, v.id ASC NULLS LAST
          `,
          [tenantId, topCandidates.map((c) => c.id)]
        );

        const grouped = new Map<
          string,
          {
            name: string;
            description: string;
            variants: string[];
            variantDescriptions: string[];
          }
        >();

        for (const r of detailRows) {
          const id = String(r.id || "").trim();
          if (!id) continue;

          let entry = grouped.get(id);
          if (!entry) {
            entry = {
              name: String(r.name || "").trim(),
              description: String(r.description || "").trim(),
              variants: [],
              variantDescriptions: [],
            };
            grouped.set(id, entry);
          }

          const vn = String(r.variant_name || "").trim();
          const vd = String(r.variant_description || "").trim();

          if (vn && !entry.variants.includes(vn)) entry.variants.push(vn);
          if (vd && !entry.variantDescriptions.includes(vd)) entry.variantDescriptions.push(vd);
        }

        function firstUsefulSnippet(text: string): string {
          const clean = String(text || "").replace(/\s+/g, " ").trim();
          if (!clean) return "";
          const firstSentence = clean.split(/(?<=[.!?])\s+/)[0]?.trim() || clean;
          return firstSentence.slice(0, 140).trim();
        }

        function compactSnippet(text: string): string {
          const clean = String(text || "").replace(/\s+/g, " ").trim();
          if (!clean) return "";

          const words = clean.split(/\s+/).slice(0, 6).join(" ");
          return words.trim();
        }

        function buildOptionLabel(serviceId: string, fallbackName: string): string {
          const entry = grouped.get(serviceId);
          if (!entry) return fallbackName;

          const snippet =
            compactSnippet(entry.description) ||
            compactSnippet(entry.variantDescriptions[0] || "") ||
            String(entry.variants[0] || "").trim();

          return snippet
            ? `${entry.name} (${snippet})`
            : entry.name;
        }

        const options = topCandidates.map((c) =>
          buildOptionLabel(c.id, c.name)
        );

        const optionsBlock = options
          .map((opt, i) => `OPTION_${i + 1}: ${opt}`)
          .join("\n");

        const ambiguityBlock =
          idiomaDestino === "en"
            ? [
                "SYSTEM_AMBIGUOUS_SERVICE_OPTIONS:",
                optionsBlock,
                "",
                "STRICT RULES:",
                "- Write a very short clarification message.",
                "- Do not explain the options in long sentences.",
                "- Show each option on its own line with a bullet.",
                "- Ask the user to choose ONE option only.",
                "- Do not invent or recommend any other service.",
                "- Maximum 4 lines total.",
              ].join("\n")
            : [
                "OPCIONES_DE_SERVICIO_AMBIGUAS_DEL_SISTEMA:",
                optionsBlock,
                "",
                "REGLAS ESTRICTAS:",
                "- Escribe una aclaración muy corta.",
                "- No expliques las opciones con frases largas.",
                "- Muestra cada opción en su propia línea con viñeta.",
                "- Pide al usuario que elija UNA sola opción.",
                "- No inventes ni recomiendes otros servicios.",
                "- Máximo 4 líneas en total.",
              ].join("\n");

        const clarifyComposed = await answerWithPromptBase({
          tenantId,
          promptBase: [
            promptBaseMem,
            "",
            ambiguityBlock,
            "",
            NO_NUMERIC_MENUS,
          ].join("\n"),
          userInput: ["USER_MESSAGE:", userInput].join("\n"),
          history,
          idiomaDestino,
          canal: canalEnvio as any,
          maxLines: MAX_LINES_META,
          fallbackText:
            idiomaDestino === "en"
              ? `Which one do you mean?\n• ${options.join("\n• ")}`
              : `¿Cuál quieres decir?\n• ${options.join("\n• ")}`,
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
            reasoningNotes: "meta_ambiguous_service_clarification",
          },
        });

        const clarifyText = String(clarifyComposed.text || "").trim();
        const normalizedClarify = clarifyText.toLowerCase();

        const mentionsAtLeastOneOption = options.some((opt) =>
          normalizedClarify.includes(opt.toLowerCase())
        );

        if (!mentionsAtLeastOneOption) {
          console.log("[META][AMBIGUOUS_SERVICE][LLM_CLARIFICATION_FALLBACK]", {
            tenantId,
            canal: canalEnvio,
            userInput,
            clarifyText,
            options,
          });

          setReply(
            idiomaDestino === "en"
              ? `Do you mean one of these options: ${options.join(" / ")}?`
              : `¿Te refieres a una de estas opciones: ${options.join(" / ")}?`,
            "sm-fallback-ambiguous-service",
            "info_servicio"
          );
          await finalizeReply();
          return;
        }

        console.log("[META][SM_FALLBACK][AMBIGUOUS_SERVICE -> ASK_CLARIFICATION]", {
          tenantId,
          canal: canalEnvio,
          userInput,
          candidates: topCandidates,
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

    const composed = await answerWithPromptBase({
      tenantId,
      promptBase: [
        promptBaseMem,
        "",
        NO_NUMERIC_MENUS,
        PRICE_QUALIFIER_RULE,
        NO_PRICE_INVENTION_RULE,
        PRICE_LIST_FORMAT_RULE,
      ].join("\n"),
      userInput: ["USER_MESSAGE:", userInput].join("\n"),
      history,
      idiomaDestino,
      canal: canalEnvio as any,
      maxLines: MAX_LINES_META,
      fallbackText: bienvenida,

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
        reasoningNotes: "meta_sm_fallback",
      },
    });

    if (composed.pendingCta) {
      (convoCtx as any).pending_cta = {
        ...composed.pendingCta,
        createdAt: new Date().toISOString(),
      };

      console.log("[PENDING_CTA][SET][sm-fallback]", {
        tenantId,
        contacto: contactoNorm,
        canal: canalEnvio as any,
        pendingCta: (convoCtx as any).pending_cta,
        replyPreview: composed.text.slice(0, 200),
      });
    }

    const finalFallbackText = await ensureReplyLanguage(composed.text, idiomaDestino);
    setReply(finalFallbackText, "sm-fallback");
    await finalizeReply();
    return;
  }
}