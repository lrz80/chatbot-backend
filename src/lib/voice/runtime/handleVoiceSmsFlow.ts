//src/lib/voice/runtime/handleVoiceSmsFlow.ts
import { twiml } from "twilio";
import { buildVoiceGatherConfig } from "../buildVoiceGatherConfig";
import { parseBookingSmsPayload } from "./voiceBookingSmsHelpers";
import { sendBookingConfirmationSms } from "./sendBookingConfirmationSms";
import { sendVoiceLinkWithState } from "./sendVoiceLinkRuntime";
import {
  askForSmsDestinationNumber,
  confirmSmsDestinationNumber,
  resolvePreferredSmsDestination,
} from "./voiceSmsDestinationRuntime";
import { resolveVoiceSmsDeliveryOutcome } from "../resolveVoiceSmsDeliveryOutcome";
import { isValidE164 } from "./voiceSmsRuntime";

import type { CallState, LinkType, VoiceLocale } from "../types";

type TenantLike = {
  id: string;
  name?: string | null;
  membresia_inicio?: string | Date | null;
  twilio_sms_number?: string | null;
  twilio_voice_number?: string | null;
};

type VoiceMetaSignalLike = {
  intent: string;
  confidence: number;
};

type SmsStateResultLike = {
  state: CallState;
  digits: string;
  smsType: LinkType | null;
  thisTurnMetaSignal: VoiceMetaSignalLike;
  rejectedReplyText?: string | null;
};

type HandleVoiceSmsFlowParams = {
  vr: twiml.VoiceResponse;
  tenant: TenantLike;
  callSid: string;
  state: CallState;
  currentLocale: VoiceLocale;
  voiceName: string;
  effectiveUserInput: string;
  digits: string;
  respuesta: string;
  callerRaw: string;
  callerE164: string;
  didNumber: string;
  channelKey: string;
  logBotSay: (args: {
    callSid: string;
    to: string;
    text: string;
    lang?: string;
    context?: string;
  }) => void;
  getTenantBrand: (tenantId: string) => Promise<string>;
  resolveVoiceSmsTurnState: (args: {
    effectiveUserInput: string;
    digits: string;
    state: CallState;
    currentLocale: VoiceLocale;
    hasActiveBookingStep: boolean;
    assistantReply: string;
    callSid: string;
    tenantId: string;
  }) => Promise<SmsStateResultLike>;
};

type HandleVoiceSmsFlowResult = {
  state: CallState;
  digits: string;
  respuesta: string;
  handled: boolean;
  twiml?: string;
};

function appendSafeText(base: string, extra?: string | null): string {
  if (!extra) return base;
  return `${base}${extra}`;
}

export async function handleVoiceSmsFlow(
  params: HandleVoiceSmsFlowParams
): Promise<HandleVoiceSmsFlowResult> {
  const {
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
    channelKey,
    logBotSay,
    getTenantBrand,
    resolveVoiceSmsTurnState,
  } = params;

  const hasActiveBookingStep = typeof state.bookingStepIndex === "number";

  const smsStateResult = await resolveVoiceSmsTurnState({
    effectiveUserInput,
    digits,
    state,
    currentLocale,
    hasActiveBookingStep,
    assistantReply: respuesta,
    callSid,
    tenantId: tenant.id,
  });

  let updatedState = smsStateResult.state;
  let updatedDigits = smsStateResult.digits;
  let updatedRespuesta = respuesta;

  const smsType = smsStateResult.smsType;
  const thisTurnMetaSignal = smsStateResult.thisTurnMetaSignal;

  if (smsStateResult.rejectedReplyText && !smsType) {
    const rejectedText = smsStateResult.rejectedReplyText;

    const gather = vr.gather(
      buildVoiceGatherConfig({
        locale: currentLocale,
        action: "/webhook/voice-response",
        numDigits: 1,
        timeout: 7,
        bargeIn: true,
      })
    );

    gather.say(
      { language: currentLocale as any, voice: voiceName as any },
      rejectedText
    );

    return {
      state: updatedState,
      digits: updatedDigits,
      respuesta: updatedRespuesta,
      handled: true,
      twiml: vr.toString(),
    };
  }

  console.log("[VOICE/SMS] dbg", {
    awaiting: updatedState.awaiting,
    pendingType: updatedState.pendingType,
    digits: updatedDigits,
    metaIntent: thisTurnMetaSignal.intent,
    metaConfidence: thisTurnMetaSignal.confidence,
    pendingMatch: !!updatedState.pendingType,
    smsType,
  });

  if (smsType) {
    const preferredDestination = resolvePreferredSmsDestination(
      updatedState,
      callerE164
    );

    const thisTurnYes =
      thisTurnMetaSignal.intent === "affirm" || updatedDigits === "1";

    if (!thisTurnYes) {
      if (!preferredDestination || !isValidE164(preferredDestination)) {
        const twimlXml = await askForSmsDestinationNumber({
          vr,
          tenantId: tenant.id,
          callSid,
          currentLocale,
          voiceName,
          state: updatedState,
          smsType,
        });

        return {
          state: updatedState,
          digits: updatedDigits,
          respuesta: updatedRespuesta,
          handled: true,
          twiml: twimlXml,
        };
      }

      const twimlXml = await confirmSmsDestinationNumber({
        vr,
        tenantId: tenant.id,
        callSid,
        currentLocale,
        voiceName,
        state: updatedState,
        smsType,
        preferredDestination,
      });

      return {
        state: updatedState,
        digits: updatedDigits,
        respuesta: updatedRespuesta,
        handled: true,
        twiml: twimlXml,
      };
    }
  }

  if (!smsType) {
    console.log(
      "[VOICE/SMS] No se detectó condición para enviar SMS.",
      "userInput=",
      effectiveUserInput,
      "respuesta=",
      updatedRespuesta
    );

    return {
      state: updatedState,
      digits: updatedDigits,
      respuesta: updatedRespuesta,
      handled: false,
    };
  }

  if (updatedState.smsSent) {
    console.log("[VOICE/SMS] SMS ya enviado en esta llamada, se omite reintento.");

    return {
      state: updatedState,
      digits: updatedDigits,
      respuesta: updatedRespuesta,
      handled: false,
    };
  }

  try {
    const bookingSmsPayload =
      smsType === "reservar"
        ? parseBookingSmsPayload(updatedState.bookingData || {})
        : null;

    if (bookingSmsPayload) {
      const bookingSmsResult = await sendBookingConfirmationSms({
        tenant,
        callSid,
        currentLocale,
        voiceName,
        state: updatedState,
        bookingSmsPayload,
        callerE164,
        didNumber,
        vr,
        logBotSay,
        successMode: "append_to_reply",
      });

      updatedState = bookingSmsResult.updatedState;
      updatedRespuesta = appendSafeText(
        updatedRespuesta,
        bookingSmsResult.appendedText
      );

      return {
        state: updatedState,
        digits: updatedDigits,
        respuesta: updatedRespuesta,
        handled: false,
      };
    }

    const brand = await getTenantBrand(tenant.id);

    const linkSmsResult = await sendVoiceLinkWithState({
      tenant,
      callSid,
      state: updatedState,
      currentLocale,
      smsType,
      callerRaw,
      callerE164,
      overrideDestE164:
        updatedState.altDest && isValidE164(updatedState.altDest)
          ? updatedState.altDest
          : null,
      brand,
      channelKey,
    });

    updatedState = linkSmsResult.updatedState;
    updatedRespuesta = appendSafeText(updatedRespuesta, linkSmsResult.appendText);

    return {
      state: updatedState,
      digits: updatedDigits,
      respuesta: updatedRespuesta,
      handled: false,
    };
  } catch (error: any) {
    console.error("[VOICE/SMS] Error enviando SMS:", error?.message || error);

    updatedRespuesta = appendSafeText(
      updatedRespuesta,
      resolveVoiceSmsDeliveryOutcome(
        {
          ok: false,
          code: "SEND_FAILED",
          message: error?.message || "Error enviando SMS.",
        },
        currentLocale
      ).appendText
    );

    return {
      state: updatedState,
      digits: updatedDigits,
      respuesta: updatedRespuesta,
      handled: false,
    };
  }
}