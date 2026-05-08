// ✅ src/routes/webhook/voice-response.ts
import { Router, Request, Response } from 'express';
import { twiml } from 'twilio';
import pool from '../../lib/db';
import { normalizarNumero } from '../../lib/senders/sms';

import { getVoiceCallState } from "../../lib/voice/getVoiceCallState";
import { upsertVoiceCallState } from "../../lib/voice/upsertVoiceCallState";
import { deleteVoiceCallState } from "../../lib/voice/deleteVoiceCallState";
import { resolveVoiceIntentFromUtteranceAsync } from "../../lib/voice/resolveVoiceIntentFromUtterance";

import { CallState } from "../../lib/voice/types";

import { resolveLocaleFromQueryLang } from "../../lib/voice/resolveVoiceLanguage";
import { renderVoiceLifecycle } from "../../lib/voice/renderVoiceLifecycle";
import { resolveVoiceConversationClosure } from "../../lib/voice/resolveVoiceConversationClosure";
import { resolveVoiceProviderVoice } from "../../lib/voice/resolveVoiceProviderVoice";
import { resolveVoiceMetaSignal } from "../../lib/voice/resolveVoiceMetaSignal";
import { resolveVoiceMenuSelection } from "../../lib/voice/resolveVoiceMenuSelection";
import { normalizeVoiceTurnInput } from "../../lib/voice/normalizeVoiceTurnInput";
import { handleVoiceSilenceTurn } from "../../lib/voice/handlers/handleVoiceSilenceTurn";
import { handleVoiceTransferTurn } from "../../lib/voice/handlers/handleVoiceTransferTurn";
import { handleVoiceInitialMenu } from "../../lib/voice/handlers/handleVoiceInitialMenu";
import { handleVoiceBookingEntry } from "../../lib/voice/handlers/handleVoiceBookingEntry";
import { getBookingFlow } from "../../lib/appointments/getBookingFlow";

import { parseBookingSmsPayload } from "../../lib/voice/runtime/voiceBookingSmsHelpers";

import {
  offerSms,
  enviarSmsConLink,
  getTenantBrand,
} from "../../lib/voice/runtime/voiceSmsRuntime";
import { sendBookingConfirmationSms } from "../../lib/voice/runtime/sendBookingConfirmationSms";
import { resolveVoiceSmsTurnState } from "../../lib/voice/runtime/resolveVoiceSmsTurnState";
import { generateVoiceAssistantReply } from "../../lib/voice/runtime/generateVoiceAssistantReply";
import { handleAwaitingSmsDestinationTurn } from "../../lib/voice/runtime/handleAwaitingSmsDestinationTurn";
import { handleActiveBookingInterruption } from "../../lib/voice/runtime/handleActiveBookingInterruption";
import { handleVoiceSmsFlow } from "../../lib/voice/runtime/handleVoiceSmsFlow";
import { persistVoiceTurn } from "../../lib/voice/runtime/persistVoiceTurn";
import { renderFinalVoiceTurn } from "../../lib/voice/runtime/renderFinalVoiceTurn";
import { resolveVoiceRequestContext } from "../../lib/voice/runtime/resolveVoiceRequestContext";
import { handleVoiceLanguageRoute } from "../../lib/voice/runtime/handleVoiceLanguageRoute";
import { resolveVoiceBusinessInfoFastpath } from "../../lib/voice/runtime/resolveVoiceBusinessInfoFastpath";

const router = Router();
const CHANNEL_KEY = "voice";

function hasInitialVoiceIntroPlayed(state: CallState): boolean {
  return String(state.bookingData?.__voice_intro_played || "") === "1";
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

router.post("/lang", handleVoiceLanguageRoute);

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

  const isFirstPostWelcomeTurn =
    (state.turn ?? 0) === 0 &&
    !state.awaiting &&
    !state.awaitingNumber &&
    typeof state.bookingStepIndex !== "number";

  const resolvedInitialVoiceIntent = effectiveUserInput
    ? await resolveVoiceIntentFromUtteranceAsync(effectiveUserInput, {
        timeoutMs: isFirstPostWelcomeTurn ? 3000 : 2500,
        minConfidence: isFirstPostWelcomeTurn ? 0.45 : 0.55,
      })
    : "unknown";

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
    const voiceRequestContext = await resolveVoiceRequestContext({
      callSid,
      didNumber,
      state,
      langParam,
      channelKey: CHANNEL_KEY,
    });

    if (!voiceRequestContext.ok) {
      return res.type("text/xml").send(voiceRequestContext.twiml);
    }

    const {
      tenant,
      cfg,
      brand,
      currentLocale,
      voiceName,
    } = voiceRequestContext;

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

    // 👉 Primer hit de la llamada: intro en inglés + “para español oprima 2” con nombre del negocio
    const initialMenuResult = await handleVoiceInitialMenu({
      vr,
      callSid,
      didNumber,
      state,
      langParam,
      userInput,
      effectiveUserInput,
      digits,
      currentLocale: currentLocale as "es-ES" | "en-US" | "pt-BR",
      voiceName,
      tenantId: tenant.id,
      tenantBrand: brand,
      cfg,
      resolveVoiceProviderVoice,
      hasInitialVoiceIntroPlayed,
      logBotSay,
    });

    if (initialMenuResult.handled) {
      return res.type("text/xml").send(initialMenuResult.twiml);
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

    // ✅ handler de silencio (cuando Twilio devuelve sin SpeechResult/Digits en turnos posteriores)
    const noUserTurnInput =
      !effectiveUserInput &&
      !digits &&
      !String(req.body.SpeechResult || "").trim() &&
      !String(req.body.Digits || "").trim();

    const silenceTurnResult = await handleVoiceSilenceTurn({
      vr,
      noUserTurnInput,
      callSid,
      tenantId: tenant.id,
      currentLocale: currentLocale as "es-ES" | "en-US" | "pt-BR",
      voiceName,
      state,
      didNumber,
      callerE164,
      logBotSay,
    });

    if (silenceTurnResult.handled) {
      return res.type("text/xml").send(silenceTurnResult.twiml);
    }

    // ===== Resultado de transferencia (Dial action) =====
    const transferTurnResult = await handleVoiceTransferTurn({
      vr,
      reqQueryTransfer: req.query?.transfer,
      dialCallStatus: req.body.DialCallStatus,
      dialCallSid: req.body.DialCallSid,
      dialCallDuration: req.body.DialCallDuration,
      dialBridged: req.body.DialBridged,
      callSid,
      tenantId: tenant.id,
      currentLocale: currentLocale as "es-ES" | "en-US" | "pt-BR",
      voiceName,
      state,
      didNumber,
      callerE164,
      callerRaw,
      tenantTwilioSmsNumber: tenant.twilio_sms_number || null,
      representativeNumberRaw: cfg?.representante_number || null,
      offerSms,
      logBotSay,
      sendSupportSms: async ({
        tenantId,
        callerE164,
        callerRaw,
        smsFromCandidate,
        callSid,
      }) => {
        await enviarSmsConLink("soporte", {
          tenantId,
          callerE164,
          callerRaw,
          smsFromCandidate,
          callSid,
        });
      },
    });

    if (transferTurnResult.handled) {
      return res.type("text/xml").send(transferTurnResult.twiml);
    }

    console.log("[VOICE][NUM_CAPTURE]", JSON.stringify({
      callSid,
      rawSpeechResult: req.body.SpeechResult,
      rawDigits: req.body.Digits,
      normalizedText: userInput,
      normalizedDigits: digits,
    }));

    const hasActiveBookingStep = typeof state.bookingStepIndex === "number";

    const earlyConversationClosure = hasActiveBookingStep
      ? { shouldClose: false }
      : await resolveVoiceConversationClosure(
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
        { language: currentLocale as any, voice: voiceName as any },
        renderVoiceLifecycle("call_goodbye", currentLocale)
      );

      vr.hangup();
      return res.type("text/xml").send(vr.toString());
    }

    if (!hasActiveBookingStep) {
      const activeBookingInterruptionResult =
        await handleActiveBookingInterruption({
          vr,
          state,
          effectiveUserInput,
          tenant,
          cfg,
          callSid,
          didNumber,
          callerE164,
          callerRaw,
          currentLocale: currentLocale as "es-ES" | "en-US" | "pt-BR",
          voiceName,
          logBotSay,
          getBookingFlow,
          normalizarNumero,
          offerSms,
          sendSupportSms: async ({
            tenantId,
            callerE164,
            callerRaw,
            smsFromCandidate,
            callSid,
          }) => {
            await enviarSmsConLink("soporte", {
              tenantId,
              callerE164,
              callerRaw,
              smsFromCandidate,
              callSid,
            });
          },
        });

      state = activeBookingInterruptionResult.state;

      if (activeBookingInterruptionResult.handled) {
        return res.type("text/xml").send(activeBookingInterruptionResult.twiml);
      }
    }

    const bookingEntryResult = await handleVoiceBookingEntry({
      vr,
      effectiveUserInput,
      resolvedInitialVoiceIntent,
      state,
      tenant,
      cfg,
      callSid,
      didNumber,
      callerE164,
      currentLocale: currentLocale as "es-ES" | "en-US" | "pt-BR",
      voiceName,
      userInput,
      digits,
      logBotSay,
    });

    state = bookingEntryResult.state;

    if (bookingEntryResult.handled) {
      return res.type("text/xml").send(bookingEntryResult.twiml);
    }

    if (
      state.awaiting &&
      state.pendingType === "reservar" &&
      effectiveUserInput
    ) {
      const bookingSmsPayload = parseBookingSmsPayload(state.bookingData || {});

      const confirmedBookingSms =
        digits === "1" ||
        ["sí", "si", "yes", "ok", "okay"].includes(
          effectiveUserInput
            .trim()
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^\p{L}\p{N}\s]/gu, "")
        ) ||
        (
          await resolveVoiceMetaSignal({
            utterance: effectiveUserInput,
            locale: currentLocale,
          })
        ).intent === "affirm";

      if (bookingSmsPayload && confirmedBookingSms) {
        const vrSms = new twiml.VoiceResponse();

        const result = await sendBookingConfirmationSms({
          tenant,
          callSid,
          currentLocale,
          voiceName,
          state,
          bookingSmsPayload,
          callerE164,
          didNumber,
          vr: vrSms,
          logBotSay,
          successMode: "direct_followup",
        });

        state = result.updatedState;

        if (result.twiml) {
          return res.type("text/xml").send(result.twiml);
        }
      }
    }

    const awaitingSmsDestinationResult = await handleAwaitingSmsDestinationTurn({
      effectiveUserInput,
      digits,
      state,
      tenant,
      callSid,
      callerE164,
      callerRaw,
      currentLocale,
      voiceName,
    });

    state = awaitingSmsDestinationResult.updatedState;

    if (awaitingSmsDestinationResult.handled) {
      return res.type("text/xml").send(awaitingSmsDestinationResult.twiml);
    }

    let respuesta: string;

    const businessInfoFastpathResult = await resolveVoiceBusinessInfoFastpath({
      tenantId: tenant.id,
      currentLocale,
      intent: resolvedInitialVoiceIntent,
      userInput: effectiveUserInput,
      infoClave: String(tenant.info_clave || ""),
      promptBaseMem: "",
    });

    if (businessInfoFastpathResult.handled) {
      respuesta = businessInfoFastpathResult.respuesta;

      console.log(
        "[VOICE][BUSINESS_INFO_FASTPATH]",
        JSON.stringify({
          callSid,
          lang: currentLocale,
          source: businessInfoFastpathResult.source,
          intent: businessInfoFastpathResult.intent,
          respuesta,
        })
      );
    } else {
      const llmResult = await generateVoiceAssistantReply({
        tenantId: tenant.id,
        membershipStart: tenant.membresia_inicio ?? null,
        channelKey: CHANNEL_KEY,
        currentLocale,
        effectiveUserInput,
        systemPrompt: (cfg.system_prompt as string)?.trim() || "",
        brand,
      });

      respuesta = llmResult.respuesta;

      console.log(
        "[VOICE][OPENAI_RAW]",
        JSON.stringify({ callSid, lang: currentLocale, respuestaRaw: respuesta })
      );
    }

    const voiceSmsFlowResult = await handleVoiceSmsFlow({
      vr,
      tenant,
      callSid,
      state,
      currentLocale,
      voiceName,
      effectiveUserInput,
      digits,
      respuesta,
      callerRaw,
      callerE164,
      didNumber,
      channelKey: CHANNEL_KEY,
      logBotSay,
      getTenantBrand,
      resolveVoiceSmsTurnState,
    });

    state = voiceSmsFlowResult.state;
    digits = voiceSmsFlowResult.digits;
    respuesta = voiceSmsFlowResult.respuesta;

    if (voiceSmsFlowResult.handled && voiceSmsFlowResult.twiml) {
      return res.type("text/xml").send(voiceSmsFlowResult.twiml);
    }

    // ——— Guardar conversación ———
    await persistVoiceTurn({
      tenantId: tenant.id,
      userText: userInput,
      assistantText: respuesta,
      callerE164: callerE164 || null,
      didNumber: didNumber || null,
    });

    const finalVoiceTurnResult = await renderFinalVoiceTurn({
      vr,
      callSid,
      state,
      currentLocale,
      voiceName,
      didNumber,
      effectiveUserInput,
      respuesta,
      logBotSay,
    });

    return res.type("text/xml").send(finalVoiceTurnResult.twiml);

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
