//src/lib/voice/handlers/handleVoiceSilenceTurn.ts
import { twiml } from "twilio";
import { getBookingFlow } from "../../appointments/getBookingFlow";
import {
  resolveBookingFlowSpeech,
  resolveBookingPromptText,
  resolveBookingRetryText,
} from "../voiceBookingHelpers";
import { deleteVoiceCallState } from "../deleteVoiceCallState";
import { upsertVoiceCallState } from "../upsertVoiceCallState";
import type { CallState } from "../types";
import { sanitizeForSay, twoSentencesMax } from "../speechFormatting";

type VoiceLocale = "es-ES" | "en-US" | "pt-BR";

type LogBotSayFn = (params: {
  callSid: string;
  to: string;
  text: string;
  lang?: string;
  context?: string;
}) => void;

type HandleVoiceSilenceTurnParams = {
  vr: twiml.VoiceResponse;
  noUserTurnInput: boolean;
  callSid: string;
  tenantId: string;
  currentLocale: VoiceLocale;
  voiceName: string;
  state: CallState;
  didNumber: string;
  callerE164: string | null;
  logBotSay: LogBotSayFn;
};

type HandleVoiceSilenceTurnResult = {
  handled: boolean;
  twiml?: string;
};

export async function handleVoiceSilenceTurn(
  params: HandleVoiceSilenceTurnParams
): Promise<HandleVoiceSilenceTurnResult> {
  const {
    vr,
    noUserTurnInput,
    callSid,
    tenantId,
    currentLocale,
    voiceName,
    state,
    didNumber,
    callerE164,
    logBotSay,
  } = params;

  if (!noUserTurnInput) {
    return { handled: false };
  }

  // 1) Si estamos dentro de booking, booking tiene prioridad absoluta.
  if (typeof state.bookingStepIndex === "number") {
    const flow = await getBookingFlow(tenantId);
    const currentStep = flow[state.bookingStepIndex];

    if (!currentStep) {
      await deleteVoiceCallState(callSid);

      const failText = currentLocale.startsWith("es")
        ? "No pude continuar con la reserva en este momento. ¿Te ayudo con algo más?"
        : currentLocale.startsWith("pt")
        ? "Não consegui continuar com a reserva neste momento. Posso te ajudar com mais alguma coisa?"
        : "I could not continue the booking right now. Can I help you with anything else?";

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

      gather.say(
        { language: currentLocale as any, voice: voiceName as any },
        failText
      );

      return {
        handled: true,
        twiml: vr.toString(),
      };
    }

    const retryBaseText = resolveBookingRetryText({
      locale: currentLocale,
      retryPrompt: currentStep.retry_prompt || "",
      retryPromptTranslations: currentStep.retry_prompt_translations || null,
      fallbackPrompt: currentStep.prompt || "",
      fallbackPromptTranslations: currentStep.prompt_translations || null,
    });

    const promptResolved = resolveBookingFlowSpeech({
      baseText: retryBaseText,
      locale: currentLocale,
      bookingData: state.bookingData || {},
      callerE164,
    });

    const retryText = twoSentencesMax(
      sanitizeForSay(
        promptResolved ||
          resolveBookingPromptText({
            locale: currentLocale,
            prompt: currentStep.prompt || "",
            promptTranslations: currentStep.prompt_translations || null,
          })
      )
    );

    await upsertVoiceCallState({
      callSid,
      tenantId,
      lang: state.lang ?? currentLocale,
      turn: state.turn ?? 0,
      awaiting: false,
      pendingType: null,
      awaitingNumber: false,
      altDest: state.altDest ?? null,
      smsSent: state.smsSent ?? false,
      bookingStepIndex: state.bookingStepIndex,
      bookingData: state.bookingData ?? {},
    });

    const isPhoneStep = currentStep.expected_type === "phone";
    const isConfirmationStep = currentStep.expected_type === "confirmation";

    const gather = vr.gather({
      input: isPhoneStep || isConfirmationStep
        ? (["speech", "dtmf"] as any)
        : (["speech"] as any),
      numDigits: isPhoneStep ? 15 : isConfirmationStep ? 1 : undefined,
      action: "/webhook/voice-response",
      method: "POST",
      language: currentLocale as any,
      speechTimeout: "auto",
      timeout: 7,
      actionOnEmptyResult: true,
      bargeIn: true,
    });

    gather.say(
      { language: currentLocale as any, voice: voiceName as any },
      retryText
    );

    logBotSay({
      callSid,
      to: didNumber || "ivr",
      text: retryText,
      lang: currentLocale,
      context: `booking_silence_retry:${currentStep.step_key}`,
    });

    return {
      handled: true,
      twiml: vr.toString(),
    };
  }

  // 2) Solo si NO hay booking activo, re-pregunta confirmación SMS.
  if (state.awaiting && state.pendingType) {
    const vrAsk = new twiml.VoiceResponse();

    const clearedState: CallState = {
      ...state,
      awaiting: false,
      pendingType: null,
      awaitingNumber: false,
    };

    await upsertVoiceCallState({
      callSid,
      tenantId,
      lang: clearedState.lang ?? currentLocale,
      turn: clearedState.turn ?? 0,
      awaiting: false,
      pendingType: null,
      awaitingNumber: false,
      altDest: clearedState.altDest ?? null,
      smsSent: clearedState.smsSent ?? false,
      bookingStepIndex: clearedState.bookingStepIndex ?? null,
      bookingData: clearedState.bookingData ?? {},
    });

    const followupText = currentLocale.startsWith("es")
      ? "Está bien. ¿Te ayudo con algo más?"
      : currentLocale.startsWith("pt")
      ? "Tudo bem. Posso te ajudar com mais alguma coisa?"
      : "No problem. Can I help you with anything else?";

    const retryText = twoSentencesMax(sanitizeForSay(followupText));

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
      { language: currentLocale as any, voice: voiceName as any },
      retryText
    );

    logBotSay({
      callSid,
      to: didNumber || "ivr",
      text: retryText,
      lang: currentLocale,
      context: "sms_offer_silence_cleared",
    });

    return {
      handled: true,
      twiml: vrAsk.toString(),
    };
  }

  // 3) Si no hay booking ni SMS pendiente, follow-up normal.
  const vrSilence = new twiml.VoiceResponse();

  const followupText = currentLocale.startsWith("es")
    ? "¿Necesitas algo más?"
    : currentLocale.startsWith("pt")
    ? "Posso te ajudar com mais alguma coisa?"
    : "Do you need anything else?";

  const retryText = twoSentencesMax(sanitizeForSay(followupText));

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
    { language: currentLocale as any, voice: voiceName as any },
    retryText
  );

  logBotSay({
    callSid,
    to: didNumber || "ivr",
    text: retryText,
    lang: currentLocale,
    context: "silence_followup_after_turn",
  });

  return {
    handled: true,
    twiml: vrSilence.toString(),
  };
}