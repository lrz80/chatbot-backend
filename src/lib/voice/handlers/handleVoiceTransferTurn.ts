//src/lib/voice/handlers/handleVoiceTransferTurn.ts
import { twiml } from "twilio";
import type { LinkType, CallState } from "../types";
import { normalizarNumero } from "../../senders/sms";
import { deleteVoiceCallState } from "../deleteVoiceCallState";
import { upsertVoiceCallState } from "../upsertVoiceCallState";
import { renderVoiceReply } from "../renderVoiceReply";
import { renderVoiceLifecycle } from "../renderVoiceLifecycle";

type VoiceLocale = "es-ES" | "en-US" | "pt-BR";

type OfferSmsFn = (
  vr: twiml.VoiceResponse,
  locale: VoiceLocale,
  voiceName: any,
  callSid: string,
  state: CallState,
  tipo: LinkType,
  tenantId: string
) => Promise<void>;

type SendSupportSmsFn = (params: {
  tenantId: string;
  callerE164: string | null;
  callerRaw: string;
  smsFromCandidate: string | null;
  callSid: string;
}) => Promise<void>;

type HandleVoiceTransferTurnParams = {
  vr: twiml.VoiceResponse;
  reqQueryTransfer: unknown;
  dialCallStatus: unknown;
  dialCallSid: unknown;
  dialCallDuration: unknown;
  dialBridged: unknown;
  callSid: string;
  tenantId: string;
  currentLocale: VoiceLocale;
  voiceName: any;
  state: CallState;
  didNumber: string;
  callerE164: string | null;
  callerRaw: string;
  tenantTwilioSmsNumber: string | null;
  representativeNumberRaw: string | null;
  offerSms: OfferSmsFn;
  sendSupportSms: SendSupportSmsFn;
};

type HandleVoiceTransferTurnResult = {
  handled: boolean;
  twiml?: string;
};

export async function handleVoiceTransferTurn(
  params: HandleVoiceTransferTurnParams
): Promise<HandleVoiceTransferTurnResult> {
  const {
    vr,
    reqQueryTransfer,
    dialCallStatus,
    dialCallSid,
    dialCallDuration,
    dialBridged,
    callSid,
    tenantId,
    currentLocale,
    voiceName,
    state,
    didNumber,
    callerE164,
    callerRaw,
    tenantTwilioSmsNumber,
    representativeNumberRaw,
    offerSms,
    sendSupportSms,
  } = params;

  const isTransferCallback =
    reqQueryTransfer === "1" || typeof dialCallStatus !== "undefined";

  if (!isTransferCallback) {
    return { handled: false };
  }

  const status = String(dialCallStatus || "").trim();

  console.log("[VOICE][TRANSFER_CALLBACK]", {
    callSid,
    tenantId,
    dialCallStatus: status,
    dialCallSid: dialCallSid || null,
    dialCallDuration: dialCallDuration || null,
    dialBridged: dialBridged || null,
    didNumber,
    callerE164,
  });

  if (["completed"].includes(status)) {
    await deleteVoiceCallState(callSid);
    vr.hangup();

    return {
      handled: true,
      twiml: vr.toString(),
    };
  }

  if (["no-answer", "busy", "failed", "canceled"].includes(status)) {
    try {
      await sendSupportSms({
        tenantId,
        callerE164,
        callerRaw,
        smsFromCandidate: tenantTwilioSmsNumber || "",
        callSid,
      });

      vr.say(
        { language: currentLocale as any, voice: voiceName },
        renderVoiceLifecycle("transfer_failed_sms_sent", currentLocale)
      );

      return {
        handled: true,
        twiml: vr.toString(),
      };
    } catch (error) {
      console.error("[TRANSFER SMS FALLBACK] Error:", error);

      vr.say(
        { language: currentLocale as any, voice: voiceName },
        renderVoiceLifecycle("transfer_failed_offer_sms", currentLocale)
      );

      await upsertVoiceCallState({
        callSid,
        tenantId,
        lang: state.lang ?? currentLocale,
        turn: state.turn ?? 0,
        awaiting: true,
        pendingType: "soporte",
        awaitingNumber: state.awaitingNumber ?? false,
        altDest: state.altDest ?? null,
        smsSent: state.smsSent ?? false,
        bookingStepIndex: state.bookingStepIndex ?? null,
        bookingData: state.bookingData ?? {},
      });

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

      return {
        handled: true,
        twiml: vr.toString(),
      };
    }
  }

  await deleteVoiceCallState(callSid);
  vr.hangup();

  return {
    handled: true,
    twiml: vr.toString(),
  };
}

type HandleHumanHandoffTurnParams = {
  vr: twiml.VoiceResponse;
  effectiveUserInput: string;
  hasActiveBookingStep: boolean;
  resolvedVoiceIntentForTurn: string | null;
  callSid: string;
  tenantId: string;
  currentLocale: VoiceLocale;
  voiceName: any;
  state: CallState;
  didNumber: string;
  callerE164: string | null;
  representativeNumberRaw: string | null;
  offerSms: OfferSmsFn;
  logBotSay: (params: {
    callSid: string;
    to: string;
    text: string;
    lang?: string;
    context?: string;
  }) => void;
};

type HandleHumanHandoffTurnResult = {
  handled: boolean;
  twiml?: string;
};

export async function handleHumanHandoffTurn(
  params: HandleHumanHandoffTurnParams
): Promise<HandleHumanHandoffTurnResult> {
  const {
    vr,
    effectiveUserInput,
    hasActiveBookingStep,
    resolvedVoiceIntentForTurn,
    callSid,
    tenantId,
    currentLocale,
    voiceName,
    state,
    didNumber,
    callerE164,
    representativeNumberRaw,
    offerSms,
    logBotSay,
  } = params;

  if (
    !effectiveUserInput ||
    hasActiveBookingStep ||
    resolvedVoiceIntentForTurn !== "human_handoff"
  ) {
    return { handled: false };
  }

  const representativeNumber = representativeNumberRaw
    ? normalizarNumero(String(representativeNumberRaw))
    : null;

  const invalidTransferTarget =
    !representativeNumber ||
    representativeNumber === didNumber ||
    representativeNumber === callerE164;

  console.log("[VOICE][TRANSFER_TARGET]", {
    callSid,
    tenantId,
    didNumber,
    callerE164,
    rawRepresentanteNumber: representativeNumberRaw,
    normalizedRepresentanteNumber: representativeNumber,
    invalidTransferTarget,
    source: "fast_human_handoff",
  });

  if (!invalidTransferTarget && representativeNumber) {
    const transferText = renderVoiceReply("transfer_connecting", {
      locale: currentLocale,
    });

    vr.say(
      { language: currentLocale as any, voice: voiceName },
      transferText
    );

    const dial = vr.dial({
      action: "/webhook/voice-response?transfer=1",
      method: "POST",
      timeout: 15,
      answerOnBridge: true,
      callerId: didNumber,
    });

    dial.number(representativeNumber);

    logBotSay({
      callSid,
      to: didNumber || "ivr",
      text: transferText,
      lang: currentLocale,
      context: "human_handoff_transfer",
    });

    return {
      handled: true,
      twiml: vr.toString(),
    };
  }

  const unavailableText = renderVoiceReply("transfer_unavailable", {
    locale: currentLocale,
  });

  vr.say(
    { language: currentLocale as any, voice: voiceName },
    unavailableText
  );

  await offerSms(
    vr,
    currentLocale,
    voiceName,
    callSid,
    state,
    "soporte",
    tenantId
  );

  logBotSay({
    callSid,
    to: didNumber || "ivr",
    text: unavailableText,
    lang: currentLocale,
    context: "human_handoff_unavailable_offer_sms",
  });

  return {
    handled: true,
    twiml: vr.toString(),
  };
}