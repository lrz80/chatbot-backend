// ✅ src/routes/webhook/voice-response.ts
import { Router, Request, Response } from 'express';
import { twiml } from 'twilio';
import pool from '../../lib/db';
import { incrementarUsoPorNumero } from '../../lib/incrementUsage';
import { cycleStartForNow } from '../../utils/billingCycle';
import { sendSMS, normalizarNumero } from '../../lib/senders/sms';
import { canUseChannel } from "../../lib/features";

import { getVoiceCallState } from "../../lib/voice/getVoiceCallState";
import { upsertVoiceCallState } from "../../lib/voice/upsertVoiceCallState";
import { deleteVoiceCallState } from "../../lib/voice/deleteVoiceCallState";
import { resolveVoiceIntentFromUtterance } from "../../lib/voice/resolveVoiceIntentFromUtterance";
import { traducirTexto } from "../../lib/traducirTexto";

import { CallState, LinkType } from "../../lib/voice/types";
import {
  wordsToDigits,
} from "../../lib/voice/voiceBookingHelpers";
import { handleVoiceBookingTurn } from "../../lib/voice/handleVoiceBookingTurn";

import {
  normalizeSpeechOutput,
  sanitizeForSay,
  twoSentencesMax,
} from "../../lib/voice/speechFormatting";

import {
  extractDigits,
} from "../../lib/voice/resolveVoiceTurnSignals";
import {
  resolveEffectiveVoiceLocale,
  resolveLocaleFromQueryLang,
  resolveVoiceLanguageSelection,
} from "../../lib/voice/resolveVoiceLanguage";
import { renderVoiceReply } from "../../lib/voice/renderVoiceReply";

import { resolveVoiceSmsFlow } from "../../lib/voice/resolveVoiceSmsFlow";
import { resolveVoiceMenuIntent } from "../../lib/voice/resolveVoiceMenuIntent";
import { generateVoiceSnippetFromKnowledge } from "../../lib/voice/generateVoiceSnippetFromKnowledge";
import { sendVoiceLinkSms } from "../../lib/voice/sendVoiceLinkSms";
import { resolveVoiceBusinessTopic } from "../../lib/voice/resolveVoiceBusinessTopic";
import { renderVoiceLifecycle } from "../../lib/voice/renderVoiceLifecycle";
import { resolveVoiceConversationClosure } from "../../lib/voice/resolveVoiceConversationClosure";
import { generateVoiceFollowupReply } from "../../lib/voice/generateVoiceFollowupReply";
import { resolveVoiceProviderVoice } from "../../lib/voice/resolveVoiceProviderVoice";
import { resolveVoiceSmsDeliveryOutcome } from "../../lib/voice/resolveVoiceSmsDeliveryOutcome";
import { renderVoiceSmsConfirmation } from "../../lib/voice/renderVoiceSmsConfirmation";
import { resolveVoiceMetaSignal } from "../../lib/voice/resolveVoiceMetaSignal";
import { resolveVoiceMenuSelection } from "../../lib/voice/resolveVoiceMenuSelection";
import { normalizeVoiceTurnInput } from "../../lib/voice/normalizeVoiceTurnInput";
import {
  buildIntroByLanguage,
  buildMainMenu,
} from "../../lib/voice/renderVoiceMenus";
import { getVoiceMenuCopy } from "../../lib/voice/voiceMenuCopy";
import { detectarIdioma } from "../../lib/detectarIdioma";

const router = Router();
const CHANNEL_KEY = "voice";

const GLOBAL_ID = process.env.GLOBAL_CHANNEL_TENANT_ID!;

// ——— Helpers para confirmar/capturar número destino ———
const maskForVoice = (n: string) =>
  (n || '')
    .replace(/^\+?(\d{0,3})\d{0,6}(\d{2})(\d{2})$/, (_, p, a, b) =>
      `+${p || ''} *** ** ${a} ${b}`
    );

const isValidE164 = (n?: string | null) => !!n && /^\+\d{10,15}$/.test(n);

const short = (s: string, n = 120) => (s.length > n ? s.slice(0, n) + '…' : s);

type BookingSmsPayload = {
  business_name: string;
  business_phone: string;
  service: string;
  datetime: string;
  customer_name: string;
  google_calendar_link: string;
};

function parseBookingSmsPayload(
  bookingData: Record<string, any> | undefined
): BookingSmsPayload | null {
  const raw = bookingData?.booking_sms_payload;

  if (!raw || typeof raw !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);

    return {
      business_name: String(parsed?.business_name || "").trim(),
      business_phone: String(parsed?.business_phone || "").trim(),
      service: String(parsed?.service || "").trim(),
      datetime: String(parsed?.datetime || "").trim(),
      customer_name: String(parsed?.customer_name || "").trim(),
      google_calendar_link: String(parsed?.google_calendar_link || "").trim(),
    };
  } catch (error) {
    console.error("[VOICE][BOOKING_SMS][PARSE_ERROR]", {
      error,
      raw,
    });
    return null;
  }
}

function hasInitialVoiceIntroPlayed(state: CallState): boolean {
  return String(state.bookingData?.__voice_intro_played || "") === "1";
}

function withInitialVoiceIntroPlayed(
  bookingData: Record<string, any> | undefined
): Record<string, any> {
  return {
    ...(bookingData || {}),
    __voice_intro_played: "1",
  };
}

function normalizeDetectedVoiceLanguage(value: unknown): "es" | "en" | "pt" | null {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (!raw) return null;

  if (
    raw === "es" ||
    raw.startsWith("es-") ||
    raw.includes("spanish") ||
    raw.includes("espanol") ||
    raw.includes("castellano")
  ) {
    return "es";
  }

  if (
    raw === "pt" ||
    raw.startsWith("pt-") ||
    raw.includes("portuguese") ||
    raw.includes("portugues")
  ) {
    return "pt";
  }

  if (
    raw === "en" ||
    raw.startsWith("en-") ||
    raw.includes("english") ||
    raw.includes("ingles")
  ) {
    return "en";
  }

  return null;
}

function buildBookingConfirmationSmsBody(
  payload: BookingSmsPayload,
  locale: "es-ES" | "en-US" | "pt-BR"
): string {
  if (locale.startsWith("es")) {
    const lines = [
      "Tu reserva quedó confirmada ✅",
      "",
      `Servicio: ${payload.service || "No especificado"}`,
      `Fecha y hora: ${payload.datetime || "No especificada"}`,
      `Cliente: ${payload.customer_name || "No especificado"}`,
    ];

    if (payload.business_phone) {
      lines.push(
        "",
        `Si necesitas cambiar tu reserva contáctanos al Tel: ${payload.business_phone}.`
      );
    }

    if (payload.google_calendar_link) {
      lines.push(
        "",
        "Guarda esta cita en tu Google Calendar:",
        payload.google_calendar_link
      );
    }

    return lines.join("\n").trim();
  }

  if (locale.startsWith("pt")) {
    const lines = [
      "Sua reserva foi confirmada ✅",
      "",
      `Serviço: ${payload.service || "Não especificado"}`,
      `Data e hora: ${payload.datetime || "Não especificada"}`,
      `Cliente: ${payload.customer_name || "Não especificado"}`,
    ];

    if (payload.business_phone) {
      lines.push(
        "",
        `Se precisar alterar sua reserva, entre em contato pelo Tel: ${payload.business_phone}.`
      );
    }

    if (payload.google_calendar_link) {
      lines.push(
        "",
        "Salve este compromisso no seu Google Calendar:",
        payload.google_calendar_link
      );
    }

    return lines.join("\n").trim();
  }

  const lines = [
    "Your booking is confirmed ✅",
    "",
    `Service: ${payload.service || "Not specified"}`,
    `Date and time: ${payload.datetime || "Not specified"}`,
    `Customer: ${payload.customer_name || "Not specified"}`,
  ];

  if (payload.business_phone) {
    lines.push(
      "",
      `If you need to change your booking, contact us at: ${payload.business_phone}.`
    );
  }

  if (payload.google_calendar_link) {
    lines.push(
      "",
      "Save this booking to your Google Calendar:",
      payload.google_calendar_link
    );
  }

  return lines.join("\n").trim();
}

//  Marca dinámica del tenant (solo `name`)
async function getTenantBrand(tenantId: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT NULLIF(TRIM(name), '') AS brand
       FROM tenants
      WHERE id = $1
      LIMIT 1`,
    [tenantId]
  );
  const brand = (rows?.[0]?.brand || '').toString().trim();
  return brand || 'Aamy';
}

async function enviarSmsConLink(
  tipo: LinkType,
  {
    tenantId,
    callerE164,
    callerRaw,
    smsFromCandidate,
    callSid,
    overrideDestE164,
  }: {
    tenantId: string;
    callerE164: string | null;
    callerRaw: string;
    smsFromCandidate: string | null;
    callSid: string;
    overrideDestE164?: string | null;
  }
) {
  const brand = await getTenantBrand(tenantId);

  const result = await sendVoiceLinkSms({
    tenantId,
    smsType: tipo,
    callerRaw,
    callerE164,
    overrideDestE164,
    smsFromCandidate,
    brand,
  });

  if (!result.ok) {
    throw new Error(result.message);
  }

  console.log("[VOICE/SMS] DEBUG about to send", {
    tipo,
    toDest: result.toDest,
    smsFrom: result.smsFrom,
    tenantId,
    callSid,
    chosen: {
      nombre: result.linkName,
      url: result.linkUrl,
    },
  });

  console.log("[VOICE/SMS] sendSMS -> enviados =", result.sentCount);

  console.log(
    "[VOICE][SMS_SENT]",
    JSON.stringify({
      callSid,
      sent: result.sentCount,
      to: result.toDest,
    })
  );

  const prevState = await getVoiceCallState(callSid);

  await upsertVoiceCallState({
    callSid,
    tenantId,
    lang: prevState?.lang ?? null,
    turn: prevState?.turn ?? 0,
    awaiting: false,
    pendingType: null,
    awaitingNumber: prevState?.awaiting_number ?? false,
    altDest: prevState?.alt_dest ?? null,
    smsSent: true,
    bookingStepIndex: prevState?.booking_step_index ?? null,
    bookingData: prevState?.booking_data ?? {},
  });

  await pool.query(
    `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
     VALUES ($1, 'system', $2, NOW(), $3, $4)`,
    [tenantId, "SMS enviado con link único.", CHANNEL_KEY, result.smsFrom || "sms"]
  );
}

//  Helper global: ofrecer SMS + setear estado
async function offerSms(
  vr: twiml.VoiceResponse,
  locale: 'es-ES' | 'en-US' | 'pt-BR',
  voiceName: any,
  callSid: string,
  state: CallState,
  tipo: LinkType,
  tenantId: string
) {
  const ask = renderVoiceReply("sms_offer_confirmation", {
    locale,
    linkType: tipo,
  });

  const gather = vr.gather({
    input: ['speech','dtmf'] as any,
    numDigits: 1,
    action: '/webhook/voice-response',
    method: 'POST',
    language: locale as any,
    speechTimeout: 'auto',
    timeout: 7,
    actionOnEmptyResult: true,
    bargeIn: true,
    // 👇 ayuda al ASR a captar “sí/yes/1”
    hints: locale.startsWith('es') ? 'sí, si, uno, 1' : 'yes, one, 1',
  });

  gather.say({ language: locale as any, voice: voiceName }, ask);

  await upsertVoiceCallState({
    callSid,
    tenantId,
    lang: state.lang ?? locale,
    turn: state.turn ?? 0,
    awaiting: true,
    pendingType: tipo,
    awaitingNumber: state.awaitingNumber ?? false,
    altDest: state.altDest ?? null,
    smsSent: state.smsSent ?? false,
    bookingStepIndex: state.bookingStepIndex ?? null,
    bookingData: state.bookingData ?? {},
  });

  // 👉 log del prompt de confirmación SMS
  logBotSay({ callSid, to: 'ivr', text: ask, lang: locale, context: `offer-sms:${tipo}` });
}

// ——— LOG HELPERS ———
function logUserAsk({
  callSid, from, digits, userInput, lang, rawBody
}: {
  callSid: string; from: string; digits?: string; userInput?: string; lang?: string; rawBody?: any;
}) {
  console.log('[VOICE][ASK]', JSON.stringify({
    callSid, from, lang, digits: digits || '', text: (userInput || '').trim(),
    // opcional: quita si no quieres payload completo
    // rawTwilio: rawBody
  }));
}

function logBotSay({
  callSid, to, text, lang, context
}: {
  callSid: string; to: string; text: string; lang?: string; context?: string;
}) {
  console.log('[VOICE][SAY]', JSON.stringify({
    callSid, to, lang, speakOut: text, ctx: context || ''
  }));
}

router.post("/lang", async (req: Request, res: Response) => {
  const rawDigits = (req.body.Digits || "").toString().trim();
  const speechRaw = (req.body.SpeechResult || "").toString().trim();

  const langSelection = resolveVoiceLanguageSelection({
    digits: rawDigits,
    speech: speechRaw,
  });

  const detectedLanguageFromSpeech =
    langSelection.hasRealUtterance && !langSelection.explicitLanguageSelection
      ? await detectarIdioma(langSelection.originalSpeech).catch(() => null)
      : null;

  const normalizedDetectedLanguage =
  normalizeDetectedVoiceLanguage(detectedLanguageFromSpeech);

  const selectedLanguage =
    normalizedDetectedLanguage || langSelection.selectedLanguage;

  console.log(
    "[VOICE][LANG]",
    JSON.stringify({
      digits: rawDigits,
      speech: langSelection.normalizedSpeech,
      detectedLanguageFromSpeech,
      normalizedDetectedLanguage,
      selectedLanguage,
      bodyKeys: Object.keys(req.body || {}),
    })
  );

  const callSid = (req.body.CallSid || "").toString();
  const to = (req.body.To || "").toString().replace(/^tel:/, "");

  const tRes = await pool.query(
    `
      SELECT id
      FROM tenants
      WHERE twilio_voice_number = $1
      LIMIT 1
    `,
    [to]
  );

  const tenant = tRes.rows[0];

  if (tenant && callSid) {
    await upsertVoiceCallState({
      callSid,
      tenantId: tenant.id,
      lang:
        selectedLanguage === "es"
          ? "es-ES"
          : selectedLanguage === "pt"
          ? "pt-BR"
          : "en-US",
      turn: 0,
      awaiting: false,
      pendingType: null,
      awaitingNumber: false,
      altDest: null,
      smsSent: false,
      bookingStepIndex: null,
      bookingData: withInitialVoiceIntroPlayed(
        langSelection.hasRealUtterance
          ? { __pending_utterance: langSelection.originalSpeech }
          : {}
      ),
    });
  }

  const vr = new twiml.VoiceResponse();
  const selectedLocale =
    selectedLanguage === "es"
      ? "es-ES"
      : selectedLanguage === "pt"
      ? "pt-BR"
      : "en-US";

  if (langSelection.explicitLanguageSelection) {
    if (selectedLocale === "es-ES") {
      vr.say(
        { language: "es-ES", voice: resolveVoiceProviderVoice("es-ES") as any },
        renderVoiceLifecycle("language_selected_es", "es-ES")
      );
      vr.redirect("/webhook/voice-response?lang=es");
      return res.type("text/xml").send(vr.toString());
    }

    if (selectedLocale === "pt-BR") {
      vr.redirect("/webhook/voice-response?lang=pt");
      return res.type("text/xml").send(vr.toString());
    }

    // Inglés no necesita confirmación hablada.
    // Sigue directo para evitar repetir saludo.
    vr.redirect("/webhook/voice-response?lang=en");
    return res.type("text/xml").send(vr.toString());
  }

  if (langSelection.hasRealUtterance) {
    vr.redirect(
      `/webhook/voice-response?lang=${
        selectedLanguage === "es"
          ? "es"
          : selectedLanguage === "pt"
          ? "pt"
          : "en"
      }`
    );
    return res.type("text/xml").send(vr.toString());
  }

  // Si no hubo selección explícita ni utterance real,
  // por defecto sigue a inglés sin volver a hablar aquí.
  vr.redirect("/webhook/voice-response?lang=en");
  return res.type("text/xml").send(vr.toString());
});

//  Handler
router.post('/', async (req: Request, res: Response) => {
  const to = (req.body.To || '').toString();
  const from = (req.body.From || '').toString();

  const didNumber  = to.replace(/^tel:/, '');
  const callerRaw  = from.replace(/^tel:/, '');
  const callerE164 = normalizarNumero(callerRaw);

  const normalizedTurnInput = normalizeVoiceTurnInput({
    speech: (req.body.SpeechResult || "").toString(),
    digits: (req.body.Digits || "").toString(),
  });

  const userInputRaw = normalizedTurnInput.text;
  const userInput = userInputRaw.trim();

  let digits = normalizedTurnInput.digits;

  // UNA SOLA instancia de VoiceResponse
  const vr = new twiml.VoiceResponse();

  const callSid: string = (req.body.CallSid || '').toString();
  const persistedState = await getVoiceCallState(callSid);

  let state: CallState = persistedState
    ? {
        awaiting: persistedState.awaiting,
        pendingType: persistedState.pending_type,
        awaitingNumber: persistedState.awaiting_number,
        altDest: persistedState.alt_dest,
        smsSent: persistedState.sms_sent,
        lang: (persistedState.lang as CallState["lang"]) || undefined,
        turn: persistedState.turn,
        bookingStepIndex:
          typeof persistedState.booking_step_index === "number"
            ? persistedState.booking_step_index
            : undefined,
        bookingData: persistedState.booking_data || {},
      }
    : {};

  const pendingUtterance =
    typeof state.bookingData?.__pending_utterance === "string"
      ? state.bookingData.__pending_utterance.trim()
      : "";

  const effectiveUserInput = userInput || pendingUtterance;

  const consumedPendingUtterance =
    !userInput && !!pendingUtterance;

  const resolvedInitialVoiceIntent = effectiveUserInput
    ? resolveVoiceIntentFromUtterance(effectiveUserInput)
    : null;

  const hasPendingUtterance = Boolean(pendingUtterance);

  const canCoerceVoiceInputToMenuSelection =
    !!effectiveUserInput &&
    !hasPendingUtterance &&
    !digits &&
    !state.awaiting &&
    !state.awaitingNumber &&
    typeof state.bookingStepIndex !== "number" &&
    resolvedInitialVoiceIntent !== "booking" &&
    effectiveUserInput.trim().split(/\s+/).length <= 2;

  if (canCoerceVoiceInputToMenuSelection) {
    const coerced = await resolveVoiceMenuSelection({
      utterance: effectiveUserInput,
      locale: state.lang,
  });

  if (coerced) {
    digits = coerced;
  }
}

  const langParam =
    typeof req.query.lang === "string" ? (req.query.lang as string) : undefined;

  // ⬇️ LOG — lo que dijo el cliente
  logUserAsk({
    callSid,
    from: callerE164 || callerRaw,
    digits,
    userInput: effectiveUserInput,
    lang:
      state.lang ||
      (typeof req.query.lang === "string"
        ? resolveLocaleFromQueryLang(req.query.lang as string, "en-US")
        : undefined),
    // rawBody: req.body, // <- útil para debug profundo, comenta si es muy ruidoso
  });

  try {
    const tRes = await pool.query(
      `SELECT id, name,
              membresia_activa, membresia_inicio,
              twilio_sms_number, twilio_voice_number
         FROM tenants
        WHERE twilio_voice_number = $1
        LIMIT 1`,
      [didNumber]
    );

    const tenant = tRes.rows[0];
    if (!tenant) {
      console.error("[VOICE] tenant no encontrado para twilio_voice_number:", didNumber);
      return res.status(404).type("text/plain").send("tenant_not_found");
    }

    if (langParam) {
      const chosen =
        state.lang ||
        resolveLocaleFromQueryLang(langParam, "en-US");

      state = {
        ...state,
        lang: chosen,
        bookingData: consumedPendingUtterance
          ? {
              ...(state.bookingData || {}),
              __pending_utterance_consumed: "1",
            }
          : state.bookingData || {},
      };

      await upsertVoiceCallState({
        callSid,
        tenantId: tenant.id,
        lang: chosen,
        turn: state.turn ?? 0,
        awaiting: state.awaiting ?? false,
        pendingType: state.pendingType ?? null,
        awaitingNumber: state.awaitingNumber ?? false,
        altDest: state.altDest ?? null,
        smsSent: state.smsSent ?? false,
        bookingStepIndex: state.bookingStepIndex ?? null,
        bookingData:
          consumedPendingUtterance
            ? Object.fromEntries(
                Object.entries(state.bookingData || {}).filter(
                  ([key]) => key !== "__pending_utterance"
                )
              )
            : state.bookingData ?? {},
      });
    }

    if (consumedPendingUtterance) {
      state = {
        ...state,
        bookingData: Object.fromEntries(
          Object.entries(state.bookingData || {}).filter(
            ([key]) => key !== "__pending_utterance"
          )
        ),
      };
    }

    // Nombre de marca del tenant (para hablar en la intro)
    const brand = await getTenantBrand(tenant.id);

    // ✅ Gate VOZ por plan + toggles + pausa (igual que el front)
    try {
      const gate = await canUseChannel(tenant.id, "voice");

      if (!gate.enabled) {
        // Limpia estado de la llamada
        await deleteVoiceCallState(callSid);

        const bye = new twiml.VoiceResponse();
        const lang =
          ((state.lang as any) ||
            (typeof req.query.lang === 'string' && req.query.lang === 'es'
              ? 'es-ES'
              : 'en-US')) as any;

        // ✅ Mensaje 100% neutro para el cliente (no menciona plan ni membresía)
        const msg = renderVoiceReply("voice_channel_unavailable", {
          locale: lang,
        });

        console.log("🛑 VOZ bloqueado por plan/toggle/pausa", {
          tenantId: tenant.id,
          plan_enabled: gate.plan_enabled,
          settings_enabled: gate.settings_enabled,
          paused_until: gate.paused_until,
          reason: gate.reason,
        });

        bye.say({ language: lang, voice: resolveVoiceProviderVoice(lang) as any }, msg);
        bye.hangup();
        return res.type("text/xml").send(bye.toString());
      }
    } catch (e) {
      console.warn("Guard VOZ: error en canUseChannel('voice'); bloquea por seguridad:", e);
      await deleteVoiceCallState(callSid);
      const bye = new twiml.VoiceResponse();
      bye.say(
        { language: "es-ES", voice: resolveVoiceProviderVoice("es-ES") as any },
        renderVoiceLifecycle("generic_voice_unavailable", "es-ES")
      );
      bye.hangup();
      return res.type("text/xml").send(bye.toString());
    }

    if (!tenant.membresia_activa) {
      // idioma según lo que ya eligió la persona (o inglés por defecto)
      const lang =
        ((state.lang as any) ||
          (typeof req.query.lang === 'string' && req.query.lang === 'es'
            ? 'es-ES'
            : 'en-US')) as any;

      const text = renderVoiceReply("assistant_unavailable", {
        locale: lang,
      });

      vr.say({ voice: resolveVoiceProviderVoice(lang) as any, language: lang }, text);
      vr.hangup();
      return res.type('text/xml').send(vr.toString());
    }

    const currentLocale = resolveEffectiveVoiceLocale({
      persistedLang: state.lang,
      queryLang: langParam,
      fallback: "en-US",
    });

    let cfgRes = await pool.query(
      `SELECT *
        FROM voice_configs
        WHERE tenant_id = $1
          AND canal = $2
          AND idioma = $3
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1`,
      [tenant.id, CHANNEL_KEY, currentLocale]
    );

    let cfg = cfgRes.rows[0];

    if (!cfg) {
      cfgRes = await pool.query(
        `SELECT *
          FROM voice_configs
          WHERE tenant_id = $1
            AND canal = $2
          ORDER BY
            CASE
              WHEN idioma = 'en-US' THEN 0
              WHEN idioma = 'es-ES' THEN 1
              WHEN idioma = 'pt-BR' THEN 2
              ELSE 3
            END,
            updated_at DESC,
            created_at DESC
          LIMIT 1`,
        [tenant.id, CHANNEL_KEY]
      );

      cfg = cfgRes.rows[0];
    }

    if (!cfg) {
      console.error("[VOICE] voice_config no encontrada para tenant:", tenant.id, "locale:", currentLocale);
      return res.status(404).type("text/plain").send("voice_config_not_found");
    }

    const voiceName: any = resolveVoiceProviderVoice(currentLocale, cfg?.voice_name);

    // 👉 Primer hit de la llamada: intro en inglés + “para español oprima 2” con nombre del negocio
    if (!state.turn && !langParam && !userInput && !digits) {
      const menuCopy = getVoiceMenuCopy("en-US");

      const englishIntroText =
        (cfg?.welcome_message || "").trim() || menuCopy.englishIntroPrompt;

      const introXml = buildIntroByLanguage({
        selected: undefined,
        resolveVoice: resolveVoiceProviderVoice,
        locale: "en-US",
        englishIntroText,
      });

      return res.type("text/xml").send(introXml);
    }

    // A partir de aquí ya contamos los turnos de la llamada
    const turn = (state.turn ?? 0) + 1;
    state = { ...state, turn };

    await upsertVoiceCallState({
      callSid,
      tenantId: tenant.id,
      lang: state.lang ?? currentLocale,
      turn: state.turn,
      awaiting: state.awaiting ?? false,
      pendingType: state.pendingType ?? null,
      awaitingNumber: state.awaitingNumber ?? false,
      altDest: state.altDest ?? null,
      smsSent: state.smsSent ?? false,
      bookingStepIndex: state.bookingStepIndex ?? null,
      bookingData: state.bookingData ?? {},
    });

    console.log('[VOICE][TURN]', JSON.stringify({ callSid, turn }));

    // ——— Menú inicial si aún no hay input ni confirmaciones pendientes ———
    if (
      turn === 1 &&
      !effectiveUserInput &&
      !digits &&
      !state.awaiting &&
      !state.awaitingNumber &&
      typeof state.bookingStepIndex !== "number"
    ) {
      const brandForMenu = await getTenantBrand(tenant.id);

      const fallbackWelcome = currentLocale.startsWith("es")
        ? `Hola, soy Aamy del equipo de ${brandForMenu}. ¿En qué puedo ayudarte hoy?`
        : currentLocale.startsWith("pt")
        ? `Olá, aqui é a Aamy da equipe de ${brandForMenu}. Como posso te ajudar hoje?`
        : `Hi, this is Aamy from ${brandForMenu}. How can I help you today?`;

      const welcomeText = twoSentencesMax(
        (cfg?.welcome_message || "").trim() || fallbackWelcome
      );

      const mainMenuPrompt = String(
        cfg?.main_menu_prompt ||
        cfg?.menu_prompt ||
        cfg?.voice_menu_prompt ||
        ""
      ).trim();

      const menuText = mainMenuPrompt
        ? twoSentencesMax(mainMenuPrompt)
        : "";

      const shouldRepeatWelcome = !hasInitialVoiceIntroPlayed(state);

      const initialPromptText = sanitizeForSay(
        normalizeSpeechOutput(
          shouldRepeatWelcome
            ? [welcomeText, menuText].filter(Boolean).join(" ")
            : menuText || welcomeText,
          currentLocale as any
        )
      );

      const gather = vr.gather({
        input: ['speech', 'dtmf'] as any,
        numDigits: 1,
        action: '/webhook/voice-response',
        method: 'POST',
        language: currentLocale as any,
        speechTimeout: 'auto',
        timeout: 7,
        actionOnEmptyResult: true,
        bargeIn: true,
      });

      gather.say(
        { language: currentLocale as any, voice: voiceName },
        initialPromptText
      );

      logBotSay({
        callSid,
        to: didNumber || "ivr",
        text: initialPromptText,
        lang: currentLocale,
        context: shouldRepeatWelcome
          ? "welcome_with_main_menu_prompt"
          : "main_menu_prompt_after_initial_intro",
      });

      return res.type("text/xml").send(vr.toString());
    }

    // ✅ handler de silencio (cuando Twilio devuelve sin SpeechResult/Digits en turnos posteriores)
    const noUserTurnInput =
      !effectiveUserInput &&
      !digits &&
      !String(req.body.SpeechResult || "").trim() &&
      !String(req.body.Digits || "").trim();

    if (noUserTurnInput) {
      // 1) Si estamos dentro de booking, booking tiene prioridad absoluta.
      // Esto evita que un SMS pendiente viejo interrumpa el step actual.
      if (typeof state.bookingStepIndex === "number") {
        const bookingState = {
          ...state,
          awaiting: false,
          pendingType: null,
          awaitingNumber: false,
        };

        await upsertVoiceCallState({
          callSid,
          tenantId: tenant.id,
          lang: bookingState.lang ?? currentLocale,
          turn: bookingState.turn ?? 0,
          awaiting: false,
          pendingType: null,
          awaitingNumber: false,
          altDest: bookingState.altDest ?? null,
          smsSent: bookingState.smsSent ?? false,
          bookingStepIndex: bookingState.bookingStepIndex ?? null,
          bookingData: bookingState.bookingData ?? {},
        });

        const bookingTurnResult = await handleVoiceBookingTurn({
          vr: new twiml.VoiceResponse(),
          tenant,
          cfg,
          callSid,
          didNumber,
          callerE164,
          currentLocale: currentLocale as "es-ES" | "en-US" | "pt-BR",
          voiceName,
          state: bookingState,
          userInput: "",
          effectiveUserInput: "",
          digits: "",
          logBotSay,
        });

        if (bookingTurnResult.handled) {
          return res.type("text/xml").send(bookingTurnResult.twiml);
        }
      }

      // 2) Solo si NO hay booking activo, re-pregunta confirmación SMS.
      if (state.awaiting && state.pendingType) {
        const vrAsk = new twiml.VoiceResponse();

        state = {
          ...state,
          awaiting: false,
          pendingType: null,
          awaitingNumber: false,
        };

        await upsertVoiceCallState({
          callSid,
          tenantId: tenant.id,
          lang: state.lang ?? currentLocale,
          turn: state.turn ?? 0,
          awaiting: false,
          pendingType: null,
          awaitingNumber: false,
          altDest: state.altDest ?? null,
          smsSent: state.smsSent ?? false,
          bookingStepIndex: state.bookingStepIndex ?? null,
          bookingData: state.bookingData ?? {},
        });

        const followupText = currentLocale.startsWith("es")
          ? "Está bien. ¿Te ayudo con algo más?"
          : currentLocale.startsWith("pt")
          ? "Tudo bem. Posso te ajudar com mais alguma coisa?"
          : "No problem. Can I help you with anything else?";

        const retryText = twoSentencesMax(
          sanitizeForSay(followupText)
        );

        const gather = vrAsk.gather({
          input: ["speech", "dtmf"] as any,
          numDigits: 1,
          action: "/webhook/voice-response",
          method: "POST",
          language: currentLocale as any,
          speechTimeout: "auto",
          timeout: 7,
          actionOnEmptyResult: true,
          bargeIn: true,
        });

        gather.say(
          { language: currentLocale as any, voice: voiceName },
          retryText
        );

        logBotSay({
          callSid,
          to: didNumber || "ivr",
          text: retryText,
          lang: currentLocale,
          context: "sms_offer_silence_cleared",
        });

        return res.type("text/xml").send(vrAsk.toString());
      }

      // 3) Si no hay booking ni SMS pendiente, follow-up normal.
      const vrSilence = new twiml.VoiceResponse();

      const followupText = currentLocale.startsWith("es")
        ? "¿Necesitas algo más?"
        : currentLocale.startsWith("pt")
        ? "Posso te ajudar com mais alguma coisa?"
        : "Do you need anything else?";

      const retryText = twoSentencesMax(
        sanitizeForSay(followupText)
      );

      const gather = vrSilence.gather({
        input: ["speech", "dtmf"] as any,
        numDigits: 1,
        action: "/webhook/voice-response",
        method: "POST",
        language: currentLocale as any,
        speechTimeout: "auto",
        timeout: 7,
        actionOnEmptyResult: true,
        bargeIn: true,
      });

      gather.say(
        { language: currentLocale as any, voice: voiceName },
        retryText
      );

      logBotSay({
        callSid,
        to: didNumber || "ivr",
        text: retryText,
        lang: currentLocale,
        context: "silence_followup_after_turn",
      });

      return res.type("text/xml").send(vrSilence.toString());
    }

    // ===== Resultado de transferencia (Dial action) =====
    const isTransferCallback = (req.query && req.query.transfer === '1') || typeof req.body.DialCallStatus !== 'undefined';
    if (isTransferCallback) {
      const status = (req.body.DialCallStatus || '').toString(); // completed | no-answer | busy | failed | canceled
      console.log('[TRANSFER CALLBACK] DialCallStatus =', status);

      if (['no-answer','busy','failed','canceled'].includes(status)) {
        try {
          // Enviar link de WhatsApp por SMS (tipo 'soporte' con sinónimos de whatsapp)
          await enviarSmsConLink('soporte', {
            tenantId: tenant.id,
            callerE164,
            callerRaw,
            smsFromCandidate: tenant.twilio_sms_number || '',
            callSid,
          });
          vr.say(
            { language: currentLocale as any, voice: voiceName },
            renderVoiceLifecycle("transfer_failed_sms_sent", currentLocale)
          );
        } catch (e) {
          console.error('[TRANSFER SMS FALLBACK] Error:', e);
          vr.say(
            { language: currentLocale as any, voice: voiceName },
            renderVoiceLifecycle("transfer_failed_offer_sms", currentLocale)
          );
          await upsertVoiceCallState({
            callSid,
            tenantId: tenant.id,
            lang: state.lang ?? currentLocale,
            turn: state.turn ?? 0,
            awaiting: true,
            pendingType: 'soporte',
            awaitingNumber: state.awaitingNumber ?? false,
            altDest: state.altDest ?? null,
            smsSent: state.smsSent ?? false,
            bookingStepIndex: state.bookingStepIndex ?? null,
            bookingData: state.bookingData ?? {},
          });
        }

        vr.gather({
          input: ['speech','dtmf'] as any,
          numDigits: 1,
          action: '/webhook/voice-response',
          method: 'POST',
          language: currentLocale as any,
          speechTimeout: 'auto',
          timeout: 7,                 // 👈 NUEVO ( segundos sin audio )
          actionOnEmptyResult: true,  // 👈 NUEVO (llama igual al action)
        });
        console.log('[VOICE][BOT]', JSON.stringify({
          callSid,
          to: didNumber,
          speakOut: 'No se pudo completar la transferencia...'
        }));

        return res.type('text/xml').send(vr.toString());
      }

      // Si fue "completed", simplemente retomamos flujo normal (no respondemos nada especial)
    }

    console.log("[VOICE][NUM_CAPTURE]", JSON.stringify({
      callSid,
      rawSpeechResult: req.body.SpeechResult,
      rawDigits: req.body.Digits,
      normalizedText: userInput,
      normalizedDigits: digits,
    }));

    const earlyConversationClosure = await resolveVoiceConversationClosure(
      effectiveUserInput,
      currentLocale
    );

    if (
      earlyConversationClosure.shouldClose &&
      !state.awaitingNumber &&
      typeof state.bookingStepIndex !== "number" &&
      resolvedInitialVoiceIntent !== "booking"
    ) {
      await deleteVoiceCallState(callSid);

      vr.say(
        { language: currentLocale as any, voice: voiceName },
        renderVoiceLifecycle("call_goodbye", currentLocale)
      );

      vr.hangup();
      return res.type("text/xml").send(vr.toString());
    }

    const hasActiveBookingFlow = typeof state.bookingStepIndex === "number";

    if (hasActiveBookingFlow && effectiveUserInput) {
      const interruptionBusinessTopic = resolveVoiceBusinessTopic(effectiveUserInput);

      const interruptionClosure = await resolveVoiceConversationClosure(
        effectiveUserInput,
        currentLocale
      );

      const interruptionMetaSignal = interruptionBusinessTopic.matched
        ? { intent: "none" as const, confidence: 0 }
        : await resolveVoiceMetaSignal({
            utterance: effectiveUserInput,
            locale: currentLocale,
          });

      const shouldLeaveBookingForBusinessTopic =
        interruptionBusinessTopic.matched &&
        interruptionBusinessTopic.topic &&
        interruptionBusinessTopic.linkType;

      const shouldCloseBooking =
        interruptionClosure.shouldClose ||
        interruptionMetaSignal.intent === "close" ||
        interruptionMetaSignal.intent === "reject";

      if (shouldLeaveBookingForBusinessTopic || shouldCloseBooking) {
        const preservedBookingData: Record<string, any> = {};

        if (state.bookingData?.__voice_intro_played) {
          preservedBookingData.__voice_intro_played =
            state.bookingData.__voice_intro_played;
        }

        state = {
          ...state,
          awaiting: false,
          pendingType: null,
          awaitingNumber: false,
          bookingStepIndex: undefined,
          bookingData: preservedBookingData,
        };

        await upsertVoiceCallState({
          callSid,
          tenantId: tenant.id,
          lang: state.lang ?? currentLocale,
          turn: state.turn ?? 0,
          awaiting: false,
          pendingType: null,
          awaitingNumber: false,
          altDest: state.altDest ?? null,
          smsSent: state.smsSent ?? false,
          bookingStepIndex: null,
          bookingData: preservedBookingData,
        });

        console.log("[VOICE][BOOKING_INTERRUPTED]", {
          callSid,
          tenantId: tenant.id,
          reason: shouldLeaveBookingForBusinessTopic
            ? "business_topic"
            : "close_or_reject",
          userInput: effectiveUserInput,
          businessTopic: interruptionBusinessTopic,
          metaSignal: interruptionMetaSignal,
        });

        if (shouldCloseBooking && !shouldLeaveBookingForBusinessTopic) {
          await deleteVoiceCallState(callSid);

          vr.say(
            { language: currentLocale as any, voice: voiceName },
            renderVoiceLifecycle("call_goodbye", currentLocale)
          );

          vr.hangup();
          return res.type("text/xml").send(vr.toString());
        }
      }
    }

    if (
      effectiveUserInput &&
      (
        typeof state.bookingStepIndex === "number" ||
        resolvedInitialVoiceIntent === "booking"
      )
    ) {
      const bookingTurnResult = await handleVoiceBookingTurn({
        vr,
        tenant,
        cfg,
        callSid,
        didNumber,
        callerE164,
        currentLocale: currentLocale as "es-ES" | "en-US" | "pt-BR",
        voiceName,
        state,
        userInput,
        effectiveUserInput,
        digits,
        logBotSay,
      });

      if (bookingTurnResult.handled) {
        return res.type("text/xml").send(bookingTurnResult.twiml);
      }

      state = bookingTurnResult.state;
    }

    const hasActiveBookingStep = typeof state.bookingStepIndex === "number";

    // ✅ capturar número cuando estábamos esperando uno
    if (!hasActiveBookingStep && state.awaitingNumber && (effectiveUserInput || digits)) {
      let rawDigits = digits || extractDigits(effectiveUserInput);

      if (!rawDigits) {
        const spoken = wordsToDigits(effectiveUserInput);
        rawDigits = extractDigits(spoken) || "";
      }
      let candidate = rawDigits ? `+${rawDigits.replace(/^\+/, '')}` : null;

      try {
        if (candidate) candidate = normalizarNumero(candidate);
      } catch {}

      if (!candidate || !isValidE164(candidate)) {
        const askAgain = renderVoiceReply("sms_invalid_destination_number", {
          locale: currentLocale,
        });
        const vrNum = new twiml.VoiceResponse();
        vrNum.say({ language: currentLocale as any, voice: voiceName }, askAgain);
        vrNum.gather({
        input: ['speech','dtmf'] as any,
        numDigits: 15,
        action: '/webhook/voice-response',
        method: 'POST',
        language: currentLocale as any,
        speechTimeout: 'auto',
        timeout: 10,               // un poco más de tiempo
        actionOnEmptyResult: true,
        bargeIn: true,
        enhanced: true,            // mejora el ASR
        speechModel: 'phone_call', // modelo recomendado para llamadas
        hints: currentLocale.startsWith('es')
          ? 'más, mas, signo, uno, dos, tres, cuatro, cinco, seis, siete, ocho, nueve, cero, guion, espacio'
          : 'plus, one, two, three, four, five, six, seven, eight, nine, zero, dash, space'
      });
        return res.type('text/xml').send(vrNum.toString());
      }

      // guardamos destino y dejamos de esperar número
      const nextState = { ...state, altDest: candidate, awaitingNumber: false };

      await upsertVoiceCallState({
        callSid,
        tenantId: tenant.id,
        lang: nextState.lang ?? currentLocale,
        turn: nextState.turn ?? 0,
        awaiting: nextState.awaiting ?? false,
        pendingType: nextState.pendingType ?? null,
        awaitingNumber: false,
        altDest: candidate,
        smsSent: nextState.smsSent ?? false,
        bookingStepIndex: nextState.bookingStepIndex ?? null,
        bookingData: nextState.bookingData ?? {},
      });

      // si había tipo pendiente, enviamos ya
      const tipo = nextState.pendingType || 'web';
      try {
        await enviarSmsConLink(tipo, {
          tenantId: tenant.id,
          callerE164,
          callerRaw,
          smsFromCandidate: tenant.twilio_sms_number || '',
          callSid,
          overrideDestE164: candidate,
        });
        const ok = renderVoiceReply("sms_sent_success", {
          locale: currentLocale,
          linkType: tipo,
        });

        const vrOk = new twiml.VoiceResponse();
        vrOk.say({ language: currentLocale as any, voice: voiceName }, ok);
        vrOk.gather({
          input: ['speech','dtmf'] as any,
          numDigits: 1,
          action: '/webhook/voice-response',
          method: 'POST',
          language: currentLocale as any,
          speechTimeout: 'auto',
          timeout: 7,
          actionOnEmptyResult: true,
        });
        return res.type('text/xml').send(vrOk.toString());
      } catch (e) {
        const bad = renderVoiceReply("sms_send_error", {
          locale: currentLocale,
        });
        const vrBad = new twiml.VoiceResponse();
        vrBad.say({ language: currentLocale as any, voice: voiceName }, bad);
        return res.type('text/xml').send(vrBad.toString());
      }
    }

    // ✅ FAST-PATH: confirmación de SMS sin pasar por OpenAI
    let earlySmsType: LinkType | null = null;

    const earlyMetaSignal = !hasActiveBookingStep
      ? await resolveVoiceMetaSignal({
          utterance: effectiveUserInput,
          locale: currentLocale,
        })
      : { intent: "other", confidence: 0 };

    if (
      state.awaiting &&
      effectiveUserInput &&
      earlyMetaSignal.intent !== "affirm" &&
      earlyMetaSignal.intent !== "reject"
    ) {
      const nextDigit = await resolveVoiceMenuSelection({
        utterance: effectiveUserInput,
        locale: currentLocale,
      });

      state = {
        ...state,
        awaiting: false,
        pendingType: null,
      };

      await upsertVoiceCallState({
        callSid,
        tenantId: tenant.id,
        lang: state.lang ?? currentLocale,
        turn: state.turn ?? 0,
        awaiting: false,
        pendingType: null,
        awaitingNumber: state.awaitingNumber ?? false,
        altDest: state.altDest ?? null,
        smsSent: state.smsSent ?? false,
        bookingStepIndex: state.bookingStepIndex ?? null,
        bookingData: state.bookingData ?? {},
      });

      if (nextDigit) {
        digits = nextDigit;
      }
    }

    const earlySmsFlow = !hasActiveBookingStep
      ? await resolveVoiceSmsFlow({
          effectiveUserInput,
          digits,
          awaiting: !!state.awaiting,
          pendingType: state.pendingType ?? null,
          assistantReply: null,
        })
      : {
          confirmed: false,
          rejected: false,
          shouldSendNow: false,
          resolvedType: null,
          newlyRequested: false,
          shouldKeepPending: false,
          nextPendingType: null,
        };

    if (state.awaiting && (earlySmsFlow.confirmed || earlySmsFlow.rejected)) {
      state = {
        ...state,
        awaiting: false,
        pendingType: null,
      };

      await upsertVoiceCallState({
        callSid,
        tenantId: tenant.id,
        lang: state.lang ?? currentLocale,
        turn: state.turn ?? 0,
        awaiting: false,
        pendingType: null,
        awaitingNumber: state.awaitingNumber ?? false,
        altDest: state.altDest ?? null,
        smsSent: state.smsSent ?? false,
        bookingStepIndex: state.bookingStepIndex ?? null,
        bookingData: state.bookingData ?? {},
      });
    }

    if (earlySmsFlow.confirmed && earlySmsFlow.shouldSendNow) {
      earlySmsType = earlySmsFlow.resolvedType;
    }

    if (earlySmsFlow.rejected) {
      const replyRaw = await generateVoiceFollowupReply({
        userInput: effectiveUserInput,
        step: "fallback",
        locale: currentLocale,
        cfg,
      });

      const localizedReply = currentLocale.startsWith("es")
        ? replyRaw
        : await traducirTexto(replyRaw, currentLocale);

      const reply = twoSentencesMax(localizedReply);

      const gather = vr.gather({
        input: ["speech", "dtmf"] as any,
        numDigits: 1,
        action: "/webhook/voice-response",
        method: "POST",
        language: currentLocale as any,
        speechTimeout: "auto",
        timeout: 7,
        actionOnEmptyResult: true,
        bargeIn: true,
      });

      gather.say({ language: currentLocale as any, voice: voiceName }, reply);

      return res.type("text/xml").send(vr.toString());
    }

    if (earlySmsType) {
      const bookingSmsPayload =
        earlySmsType === "reservar"
          ? parseBookingSmsPayload(state.bookingData || {})
          : null;

      if (bookingSmsPayload) {
        const smsFrom =
          tenant.twilio_sms_number || tenant.twilio_voice_number || "";

        const toDest =
          (state.altDest && isValidE164(state.altDest) ? state.altDest : null) ||
          callerE164;

        const body = buildBookingConfirmationSmsBody(
          bookingSmsPayload,
          currentLocale
        );

        console.log("[VOICE][BOOKING_SMS][EARLY_SEND_ATTEMPT]", {
          callSid,
          tenantId: tenant.id,
          smsFrom,
          toDest,
          body,
          bookingSmsPayload,
        });

        if (!toDest || !/^\+\d{10,15}$/.test(toDest)) {
          const bad = currentLocale.startsWith("es")
            ? "No pude validar tu número para enviarte el SMS."
            : currentLocale.startsWith("pt")
            ? "Não consegui validar seu número para enviar o SMS."
            : "I could not validate your number to send the SMS.";

          vr.say({ language: currentLocale as any, voice: voiceName }, bad);
          vr.gather({
            input: ['speech', 'dtmf'] as any,
            numDigits: 1,
            action: '/webhook/voice-response',
            method: 'POST',
            language: currentLocale as any,
            speechTimeout: 'auto',
            timeout: 7,
            actionOnEmptyResult: true,
          });

          return res.type('text/xml').send(vr.toString());
        }

        if (!smsFrom) {
          const bad = currentLocale.startsWith("es")
            ? "No hay un número SMS configurado para enviar la confirmación."
            : currentLocale.startsWith("pt")
            ? "Não há um número SMS configurado para enviar a confirmação."
            : "There is no SMS number configured to send the confirmation.";

          vr.say({ language: currentLocale as any, voice: voiceName }, bad);
          vr.gather({
            input: ['speech', 'dtmf'] as any,
            numDigits: 1,
            action: '/webhook/voice-response',
            method: 'POST',
            language: currentLocale as any,
            speechTimeout: 'auto',
            timeout: 7,
            actionOnEmptyResult: true,
          });

          return res.type('text/xml').send(vr.toString());
        }

        if (smsFrom.startsWith("whatsapp:")) {
          const bad = currentLocale.startsWith("es")
            ? "El número configurado es WhatsApp y no puede enviar SMS."
            : currentLocale.startsWith("pt")
            ? "O número configurado é apenas WhatsApp e não pode enviar SMS."
            : "The configured number is WhatsApp-only and cannot send SMS.";

          vr.say({ language: currentLocale as any, voice: voiceName }, bad);
          vr.gather({
            input: ['speech', 'dtmf'] as any,
            numDigits: 1,
            action: '/webhook/voice-response',
            method: 'POST',
            language: currentLocale as any,
            speechTimeout: 'auto',
            timeout: 7,
            actionOnEmptyResult: true,
          });

          return res.type('text/xml').send(vr.toString());
        }

        const sentCount = await sendSMS({
          mensaje: body,
          destinatarios: [toDest],
          fromNumber: smsFrom || undefined,
          tenantId: tenant.id,
          campaignId: null,
        });

        console.log("[VOICE][BOOKING_SMS][EARLY_SENT]", {
          callSid,
          tenantId: tenant.id,
          sentCount,
          toDest,
        });

        state = {
          ...state,
          awaiting: false,
          pendingType: null,
          smsSent: true,
        };

        await upsertVoiceCallState({
          callSid,
          tenantId: tenant.id,
          lang: state.lang ?? currentLocale,
          turn: state.turn ?? 0,
          awaiting: false,
          pendingType: null,
          awaitingNumber: state.awaitingNumber ?? false,
          altDest: state.altDest ?? null,
          smsSent: true,
          bookingStepIndex: state.bookingStepIndex ?? null,
          bookingData: state.bookingData ?? {},
        });

        await pool.query(
          `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
          VALUES ($1, 'user', $2, NOW(), $3, $4)`,
          [tenant.id, effectiveUserInput, CHANNEL_KEY, callerE164 || 'anónimo']
        );

        await pool.query(
          `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
          VALUES ($1, 'assistant', $2, NOW(), $3, $4)`,
          [tenant.id, "SMS enviado con confirmación de reserva.", CHANNEL_KEY, didNumber || 'sistema']
        );

        await pool.query(
          `INSERT INTO interactions (tenant_id, canal, created_at)
          VALUES ($1, $2, NOW())`,
          [tenant.id, CHANNEL_KEY]
        );

        const ok = currentLocale.startsWith("es")
          ? "Te acabo de enviar los detalles de tu reserva por SMS."
          : currentLocale.startsWith("pt")
          ? "Acabei de te enviar os detalhes da sua reserva por SMS."
          : "I just sent your booking details by SMS.";

        vr.say({ language: currentLocale as any, voice: voiceName }, ok);
        vr.gather({
          input: ['speech', 'dtmf'] as any,
          numDigits: 1,
          action: '/webhook/voice-response',
          method: 'POST',
          language: currentLocale as any,
          speechTimeout: 'auto',
          timeout: 7,
          actionOnEmptyResult: true,
        });

        await incrementarUsoPorNumero(didNumber);
        return res.type('text/xml').send(vr.toString());
      }

      await enviarSmsConLink(earlySmsType, {
        tenantId: tenant.id,
        callerE164,
        callerRaw,
        smsFromCandidate: tenant.twilio_sms_number || '',
        callSid,
        overrideDestE164: (state.altDest && isValidE164(state.altDest)) ? state.altDest : undefined,
      });

      const ok = renderVoiceReply("sms_sent_success", {
        locale: currentLocale,
        linkType: earlySmsType,
      });

      vr.say({ language: currentLocale as any, voice: voiceName }, ok);
      vr.gather({
        input: ['speech', 'dtmf'] as any,
        numDigits: 1,
        action: '/webhook/voice-response',
        method: 'POST',
        language: currentLocale as any,
        speechTimeout: 'auto',
        timeout: 7,
        actionOnEmptyResult: true,
      });

      await pool.query(
        `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
        VALUES ($1, 'user', $2, NOW(), $3, $4)`,
        [tenant.id, effectiveUserInput, CHANNEL_KEY, callerE164 || 'anónimo']
      );

      await pool.query(
        `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
        VALUES ($1, 'assistant', $2, NOW(), $3, $4)`,
        [tenant.id, ok, CHANNEL_KEY, didNumber || 'sistema']
      );

      await pool.query(
        `INSERT INTO interactions (tenant_id, canal, created_at)
        VALUES ($1, $2, NOW())`,
        [tenant.id, CHANNEL_KEY]
      );

      await incrementarUsoPorNumero(didNumber);
      return res.type('text/xml').send(vr.toString());
    }

    // ===== IVR simple por dígito (1/2/3/4) =====
    const resolvedVoiceIntentForTurn = effectiveUserInput
      ? resolveVoiceIntentFromUtterance(effectiveUserInput)
      : null;

    if (
      digits &&
      !effectiveUserInput &&
      !hasActiveBookingStep &&
      !state.awaiting &&
      resolvedVoiceIntentForTurn !== "booking"
    ) {
      const REPRESENTANTE_NUMBER = cfg?.representante_number || null;
      const menuIntent = resolveVoiceMenuIntent(digits, currentLocale);

      if (menuIntent?.kind === "snippet") {
        const brand = await getTenantBrand(tenant.id);
        const spoken = await generateVoiceSnippetFromKnowledge({
          topic: menuIntent.topic,
          cfg,
          locale: currentLocale as any,
          brand,
        });

        vr.say({ language: currentLocale as any, voice: voiceName }, spoken);

        await offerSms(
          vr,
          currentLocale as any,
          voiceName,
          callSid,
          state,
          menuIntent.linkType,
          tenant.id
        );

        return res.type("text/xml").send(vr.toString());
      }

      if (menuIntent?.kind === "transfer") {
        if (REPRESENTANTE_NUMBER) {
          vr.say(
            { language: currentLocale as any, voice: voiceName },
            renderVoiceReply("transfer_connecting", {
              locale: currentLocale,
            })
          );

          const dial = vr.dial({
            action: "/webhook/voice-response?transfer=1",
            method: "POST",
            timeout: 20,
          });

          dial.number(REPRESENTANTE_NUMBER);
          return res.type("text/xml").send(vr.toString());
        }

        vr.say(
          { language: currentLocale as any, voice: voiceName },
          renderVoiceReply("transfer_unavailable", {
            locale: currentLocale,
          })
        );

        await offerSms(
          vr,
          currentLocale as any,
          voiceName,
          callSid,
          state,
          "soporte",
          tenant.id
        );

        return res.type("text/xml").send(vr.toString());
      }

      vr.say(
        { language: currentLocale as any, voice: voiceName },
        renderVoiceLifecycle("menu_option_not_recognized", currentLocale)
      );
    }

    // ——— FAST INTENT: si el usuario pidió algo directo (sin DTMF), lee desde prompt y luego ofrece SMS ———
    if (effectiveUserInput && !hasActiveBookingStep) {
      const businessTopic = resolveVoiceBusinessTopic(effectiveUserInput);

      const sayAndOffer = async (
        topic: "precios" | "horarios" | "ubicacion" | "pagos",
        tipoLink: LinkType
      ) => {
        const spokenRaw = await generateVoiceSnippetFromKnowledge({
          topic,
          cfg,
          locale: currentLocale as any,
          brand,
        });

        const spoken = sanitizeForSay(
          normalizeSpeechOutput(twoSentencesMax(spokenRaw), currentLocale as any)
        );

        const smsAsk = renderVoiceReply("sms_offer_confirmation", {
          locale: currentLocale,
          linkType: tipoLink,
        });

        const combinedText = twoSentencesMax(
          sanitizeForSay(`${spoken} ${smsAsk}`)
        );

        const gather = vr.gather({
          input: ["speech", "dtmf"] as any,
          numDigits: 1,
          action: "/webhook/voice-response",
          method: "POST",
          language: currentLocale as any,
          speechTimeout: "auto",
          timeout: 7,
          actionOnEmptyResult: true,
          bargeIn: true,
          hints: currentLocale.startsWith("es") ? "sí, si, no, uno, 1" : "yes, no, one, 1",
        });

        gather.say(
          { language: currentLocale as any, voice: voiceName },
          combinedText
        );

        await upsertVoiceCallState({
          callSid,
          tenantId: tenant.id,
          lang: state.lang ?? currentLocale,
          turn: state.turn ?? 0,
          awaiting: true,
          pendingType: tipoLink,
          awaitingNumber: state.awaitingNumber ?? false,
          altDest: state.altDest ?? null,
          smsSent: state.smsSent ?? false,
          bookingStepIndex: state.bookingStepIndex ?? null,
          bookingData: state.bookingData ?? {},
        });

        logBotSay({
          callSid,
          to: didNumber || "ivr",
          text: combinedText,
          lang: currentLocale,
          context: `business_topic_with_sms_offer:${topic}`,
        });

        return res.type("text/xml").send(vr.toString());
      };

      if (businessTopic.matched && businessTopic.topic && businessTopic.linkType) {
        return await sayAndOffer(businessTopic.topic, businessTopic.linkType);
      }
    }

    // ——— OpenAI ———
    let respuesta = renderVoiceReply("fallback_not_understood", {
      locale: currentLocale,
    });
    try {
      const { default: OpenAI } = await import('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
      const brand = await getTenantBrand(tenant.id);

      // ✅ timeout de 6s para evitar cuelgues
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0, // 👈 evita alucinaciones
        messages: [
          {
            role: 'system',
            content:
              (cfg.system_prompt as string)?.trim() ||
              `Eres Amy, asistente telefónica del negocio ${brand}. 
              REGLAS:
              - NO menciones precios ni montos al hablar, nunca inventes números.
              - Si el usuario pregunta por precios, horarios, ubicación o pagos, ofrece enviar un SMS con el enlace correspondiente (no los leas en voz).
              - Jamás leas URL en voz. 
              - Responde breve y natural.`
          },
          { role: 'user', content: effectiveUserInput },
        ],
      }, { signal: controller.signal as any });
      clearTimeout(timer);

      respuesta = completion.choices[0]?.message?.content?.trim() || respuesta;
      console.log('[VOICE][OPENAI_RAW]', JSON.stringify({ callSid, lang: currentLocale, respuestaRaw: respuesta }));

      const usage = (completion as any).usage ?? {};
      const totalTokens =
        typeof usage.total_tokens === 'number'
          ? usage.total_tokens
          : (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);

      const cicloInicio = cycleStartForNow(tenant.membresia_inicio);
      if (totalTokens > 0) {
        await pool.query(
          `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
          VALUES ($1, $2, $3::date, $4)
          ON CONFLICT (tenant_id, canal, mes)
          DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
          [tenant.id, CHANNEL_KEY, cicloInicio, totalTokens]
        );
      }
    } catch (e) {
      console.warn('⚠️ OpenAI falló, usando fallback:', e);
    }

    // ——— Decidir si hay que ENVIAR SMS con link útil ———
    const tagMatch = respuesta.match(/\[\[SMS:(reservar|comprar|soporte|web)\]\]/i);
    let smsType: LinkType | null = tagMatch ? (tagMatch[1].toLowerCase() as LinkType) : null;

    if (tagMatch) {
      respuesta = respuesta.replace(tagMatch[0], "").trim();
    }

    const resolvedSmsFlow = await resolveVoiceSmsFlow({
      effectiveUserInput,
      digits,
      awaiting: !!state.awaiting,
      pendingType: state.pendingType ?? null,
      assistantReply: respuesta,
    });

    if (!smsType && resolvedSmsFlow.shouldSendNow) {
      smsType = resolvedSmsFlow.resolvedType;
    }

    if (!smsType && resolvedSmsFlow.rejected && state.awaiting) {
      console.log("[VOICE/SMS] Usuario rechazó el SMS (estado).");

      state = {
        ...state,
        awaiting: false,
        pendingType: null,
      };

      await upsertVoiceCallState({
        callSid,
        tenantId: tenant.id,
        lang: state.lang ?? currentLocale,
        turn: state.turn ?? 0,
        awaiting: false,
        pendingType: null,
        awaitingNumber: state.awaitingNumber ?? false,
        altDest: state.altDest ?? null,
        smsSent: state.smsSent ?? false,
        bookingStepIndex: state.bookingStepIndex ?? null,
        bookingData: state.bookingData ?? {},
      });
    }

    if (!smsType && resolvedSmsFlow.newlyRequested) {
      smsType = resolvedSmsFlow.resolvedType;
      console.log("[VOICE/SMS] Usuario solicitó SMS → tipo inferido =", smsType);
    }

    if (!smsType && resolvedSmsFlow.shouldKeepPending && resolvedSmsFlow.nextPendingType) {
      const ask = renderVoiceReply("sms_offer_confirmation", {
        locale: currentLocale,
        linkType: resolvedSmsFlow.nextPendingType,
      });

      respuesta = `${respuesta} ${ask} <SMS_PENDING:${resolvedSmsFlow.nextPendingType}>`.trim();

      await upsertVoiceCallState({
        callSid,
        tenantId: tenant.id,
        lang: state.lang ?? currentLocale,
        turn: state.turn ?? 0,
        awaiting: true,
        pendingType: resolvedSmsFlow.nextPendingType,
        awaitingNumber: state.awaitingNumber ?? false,
        altDest: state.altDest ?? null,
        smsSent: state.smsSent ?? false,
        bookingStepIndex: state.bookingStepIndex ?? null,
        bookingData: state.bookingData ?? {},
      });
    }

    const thisTurnMetaSignal = await resolveVoiceMetaSignal({
      utterance: effectiveUserInput,
      locale: currentLocale,
    });

    console.log('[VOICE/SMS] dbg', {
      awaiting: state.awaiting,
      pendingType: state.pendingType,
      digits,
      metaIntent: thisTurnMetaSignal.intent,
      metaConfidence: thisTurnMetaSignal.confidence,
      tagMatch: !!tagMatch,
      pendingMatch: !!state.pendingType,
      smsType,
    });

    // ——— Confirmación/Captura de número destino antes de enviar ———
    if (smsType) {
      // número preferido: alterno confirmado > callerE164
      const preferred = (state.altDest && isValidE164(state.altDest)) ? state.altDest : callerE164;

      const thisTurnYes =
        thisTurnMetaSignal.intent === "affirm" || digits === "1";

      if (!thisTurnYes) {
        if (!isValidE164(preferred)) {
          const askNum = renderVoiceReply("sms_ask_destination_number", {
            locale: currentLocale,
            linkType: smsType,
          });

          await upsertVoiceCallState({
            callSid,
            tenantId: tenant.id,
            lang: state.lang ?? currentLocale,
            turn: state.turn ?? 0,
            awaiting: false,
            pendingType: smsType,
            awaitingNumber: true,
            altDest: state.altDest ?? null,
            smsSent: state.smsSent ?? false,
            bookingStepIndex: state.bookingStepIndex ?? null,
            bookingData: state.bookingData ?? {},
          });

          vr.say({ language: currentLocale as any, voice: voiceName }, askNum);
          vr.gather({
            input: ['speech','dtmf'] as any,
            numDigits: 15,
            action: '/webhook/voice-response',
            method: 'POST',
            language: currentLocale as any,
            speechTimeout: 'auto',
            timeout: 10,
            actionOnEmptyResult: true,
            bargeIn: true,
            enhanced: true,
            speechModel: 'phone_call',
            hints: currentLocale.startsWith('es')
              ? 'más, mas, signo, uno, dos, tres, cuatro, cinco, seis, siete, ocho, nueve, cero, guion, espacio'
              : 'plus, one, two, three, four, five, six, seven, eight, nine, zero, dash, space'
          });

          return res.type('text/xml').send(vr.toString());
        }

        const confirm = renderVoiceSmsConfirmation(
          currentLocale,
          maskForVoice(preferred)
        );

        await upsertVoiceCallState({
          callSid,
          tenantId: tenant.id,
          lang: state.lang ?? currentLocale,
          turn: state.turn ?? 0,
          awaiting: true,
          pendingType: smsType,
          awaitingNumber: false,
          altDest: state.altDest ?? null,
          smsSent: state.smsSent ?? false,
          bookingStepIndex: state.bookingStepIndex ?? null,
          bookingData: state.bookingData ?? {},
        });

        vr.say({ language: currentLocale as any, voice: voiceName }, confirm);
        vr.gather({
          input: ['speech','dtmf'] as any,
          numDigits: 15,
          action: '/webhook/voice-response',
          method: 'POST',
          language: currentLocale as any,
          speechTimeout: 'auto',
          timeout: 7,
          actionOnEmptyResult: true,
        });

        return res.type('text/xml').send(vr.toString());
      }

      // Si thisTurnYes === true, seguimos abajo al bloque de envío
    }

    // ——— Si hay que mandar SMS ———
    if (smsType) {
      if (state.smsSent) {
        console.log("[VOICE/SMS] SMS ya enviado en esta llamada, se omite reintento.");
      } else {
        try {
          const smsFrom =
            tenant.twilio_sms_number || tenant.twilio_voice_number || "";

          const toDest =
            (state.altDest && isValidE164(state.altDest) ? state.altDest : null) ||
            callerE164;

          const bookingSmsPayload =
            smsType === "reservar"
              ? parseBookingSmsPayload(state.bookingData || {})
              : null;

          if (bookingSmsPayload) {
            const body = buildBookingConfirmationSmsBody(
              bookingSmsPayload,
              currentLocale
            );

            console.log("[VOICE][BOOKING_SMS][SEND_ATTEMPT]", {
              callSid,
              tenantId: tenant.id,
              smsFrom,
              toDest,
              body,
            });

            if (!toDest || !/^\+\d{10,15}$/.test(toDest)) {
              console.warn("[VOICE][BOOKING_SMS] Número destino inválido:", {
                callerRaw,
                toDest,
              });

              respuesta += currentLocale.startsWith("es")
                ? " No pude validar tu número para enviarte el SMS."
                : currentLocale.startsWith("pt")
                ? " Não consegui validar seu número para enviar o SMS."
                : " I could not validate your number to send the SMS.";
            } else if (!smsFrom) {
              console.warn("[VOICE][BOOKING_SMS] No hay número SMS configurado.");
              respuesta += currentLocale.startsWith("es")
                ? " No hay un número SMS configurado para enviar la confirmación."
                : currentLocale.startsWith("pt")
                ? " Não há um número SMS configurado para enviar a confirmação."
                : " There is no SMS number configured to send the confirmation.";
            } else if (smsFrom.startsWith("whatsapp:")) {
              console.warn("[VOICE][BOOKING_SMS] El número configurado es WhatsApp-only.");
              respuesta += currentLocale.startsWith("es")
                ? " El número configurado es WhatsApp y no puede enviar SMS."
                : currentLocale.startsWith("pt")
                ? " O número configurado é apenas WhatsApp e não pode enviar SMS."
                : " The configured number is WhatsApp-only and cannot send SMS.";
            } else {
              const sentCount = await sendSMS({
                mensaje: body,
                destinatarios: [toDest],
                fromNumber: smsFrom || undefined,
                tenantId: tenant.id,
                campaignId: null,
              });

              console.log("[VOICE][BOOKING_SMS][SENT]", {
                callSid,
                tenantId: tenant.id,
                sentCount,
                toDest,
              });

              state = {
                ...state,
                awaiting: false,
                pendingType: null,
                smsSent: true,
              };

              await upsertVoiceCallState({
                callSid,
                tenantId: tenant.id,
                lang: state.lang ?? currentLocale,
                turn: state.turn ?? 0,
                awaiting: false,
                pendingType: null,
                awaitingNumber: state.awaitingNumber ?? false,
                altDest: state.altDest ?? null,
                smsSent: true,
                bookingStepIndex: state.bookingStepIndex ?? null,
                bookingData: state.bookingData ?? {},
              });

              await pool.query(
                `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
                VALUES ($1, 'system', $2, NOW(), $3, $4)`,
                [tenant.id, "SMS enviado con confirmación de reserva.", CHANNEL_KEY, smsFrom]
              );

              respuesta += currentLocale.startsWith("es")
                ? " Te acabo de enviar los detalles por SMS."
                : currentLocale.startsWith("pt")
                ? " Acabei de te enviar os detalhes por SMS."
                : " I just sent you the booking details by SMS.";
            }
          } else {
            const brand = await getTenantBrand(tenant.id);

            const result = await sendVoiceLinkSms({
              tenantId: tenant.id,
              smsType,
              callerRaw,
              callerE164,
              overrideDestE164:
                state.altDest && isValidE164(state.altDest) ? state.altDest : null,
              smsFromCandidate: tenant.twilio_sms_number || tenant.twilio_voice_number || "",
              brand,
            });

            const smsDeliveryOutcome = resolveVoiceSmsDeliveryOutcome(result, currentLocale);

            if (!result.ok) {
              console.warn("[VOICE/SMS] No se pudo enviar el SMS:", result.code, result.message);
              respuesta += smsDeliveryOutcome.appendText;
            } else {
              console.log("[VOICE/SMS] sendSMS -> enviados =", result.sentCount);

              state = {
                ...state,
                awaiting: false,
                pendingType: null,
                smsSent: true,
              };

              await upsertVoiceCallState({
                callSid,
                tenantId: tenant.id,
                lang: state.lang ?? currentLocale,
                turn: state.turn ?? 0,
                awaiting: false,
                pendingType: null,
                awaitingNumber: state.awaitingNumber ?? false,
                altDest: state.altDest ?? null,
                smsSent: true,
                bookingStepIndex: state.bookingStepIndex ?? null,
                bookingData: state.bookingData ?? {},
              });

              await pool.query(
                `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
                VALUES ($1, 'system', $2, NOW(), $3, $4)`,
                [tenant.id, "SMS enviado con link único.", CHANNEL_KEY, result.smsFrom]
              );

              respuesta += smsDeliveryOutcome.appendText;
            }
          }
        } catch (e: any) {
          console.error("[VOICE/SMS] Error enviando SMS:", e?.message || e);
          respuesta += resolveVoiceSmsDeliveryOutcome(
            {
              ok: false,
              code: "SEND_FAILED",
              message: e?.message || "Error enviando SMS.",
            },
            currentLocale
          ).appendText;
        }
      }
    } else {
      console.log(
        "[VOICE/SMS] No se detectó condición para enviar SMS.",
        "userInput=",
        short(effectiveUserInput),
        "respuesta=",
        short(respuesta)
      );
    }

    // ——— Guardar conversación ———
    await pool.query(
      `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
       VALUES ($1, 'user', $2, NOW(), 'voz', $3)`,
      [tenant.id, userInput, callerE164 || 'anónimo']
    );
    await pool.query(
      `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
       VALUES ($1, 'assistant', $2, NOW(), 'voz', $3)`,
      [tenant.id, respuesta, didNumber || 'sistema']
    );
    await pool.query(
      `INSERT INTO interactions (tenant_id, canal, created_at)
       VALUES ($1, 'voz', NOW())`,
      [tenant.id]
    );

    await incrementarUsoPorNumero(didNumber);

    // ——— ¿Terminamos? ———
    const conversationClosure = await resolveVoiceConversationClosure(
      effectiveUserInput,
      currentLocale
    );
    const fin =
      !hasActiveBookingStep &&
      conversationClosure.shouldClose;

    // ✅ recorte a 2 frases y normalización de horas antes de locutar
    const speakOut = sanitizeForSay(
      normalizeSpeechOutput(twoSentencesMax(respuesta), currentLocale as any)
    );

    // ⬇️ LOG — lo que dirá el bot (lo que Twilio locuta)
    logBotSay({
      callSid,
      to: didNumber,
      text: speakOut,
      lang: currentLocale as any,
      context: 'final-say'
    });

    if (!fin) {
      const contGather = vr.gather({
        input: ['speech','dtmf'] as any,
        numDigits: 1,
        action: '/webhook/voice-response',
        method: 'POST',
        language: currentLocale as any,
        speechTimeout: 'auto',
        timeout: 7,
        actionOnEmptyResult: true,
        bargeIn: true,
      });

      contGather.say(
        { language: currentLocale as any, voice: voiceName },
        speakOut
      );
    } else {
      await deleteVoiceCallState(callSid);

      vr.say(
        { language: currentLocale as any, voice: voiceName },
        renderVoiceLifecycle("call_goodbye", currentLocale)
      );

      vr.hangup();
    }

    return res.type('text/xml').send(vr.toString());
  } catch (err) {
  console.error('❌ Error en voice-response:', err);
  const vrErr = new twiml.VoiceResponse();
  const errLocale = ((state.lang as any) || 'es-ES') as any; // ⛔ no usar cfgLocale aquí
  const errText = renderVoiceLifecycle("fatal_error_offer_sms", errLocale);
  vrErr.say({ language: errLocale as any, voice: resolveVoiceProviderVoice(errLocale) as any }, errText);
  vrErr.gather({
    input: ['speech','dtmf'] as any,
    numDigits: 1,
    action: '/webhook/voice-response',
    method: 'POST',
    language: errLocale as any,
    speechTimeout: 'auto',
  });

  return res.type('text/xml').send(vrErr.toString());  // ✅ mantener la llamada viva
}
});

export default router;
