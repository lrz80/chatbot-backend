//src/lib/voice/runtime/sendBookingConfirmationSms.ts
import { twiml } from "twilio";
import { buildVoiceGatherConfig } from "../buildVoiceGatherConfig";
import { sendSMS } from "../../senders/sms";
import { upsertVoiceCallState } from "../upsertVoiceCallState";
import type { CallState, VoiceLocale } from "../types";
import type { BookingSmsPayload } from "./voiceBookingSmsHelpers";
import { buildBookingConfirmationSmsBody } from "./voiceBookingSmsHelpers";
import { isValidE164 } from "./voiceSmsRuntime";

type TenantSmsConfig = {
  id: string;
  twilio_sms_number?: string | null;
  twilio_voice_number?: string | null;
};

type LogBotSayFn = (params: {
  callSid: string;
  to: string;
  text: string;
  lang?: string;
  context?: string;
}) => void;

type SuccessMode = "direct_followup" | "append_to_reply";

type SendBookingConfirmationSmsParams = {
  tenant: TenantSmsConfig;
  callSid: string;
  currentLocale: VoiceLocale;
  voiceName: any;
  state: CallState;
  bookingSmsPayload: BookingSmsPayload;
  callerE164: string | null;
  didNumber: string;
  vr: twiml.VoiceResponse;
  logBotSay: LogBotSayFn;
  successMode: SuccessMode;
};

export type SendBookingConfirmationSmsResult = {
  sent: boolean;
  updatedState: CallState;
  twiml?: string;
  appendedText?: string;
};

function buildInvalidNumberText(
  locale: VoiceLocale,
  withFollowup: boolean
): string {
  if (locale.startsWith("es")) {
    return withFollowup
      ? "No pude validar tu número para enviarte el SMS. ¿Te ayudo con algo más?"
      : "No pude validar tu número para enviarte el SMS.";
  }

  if (locale.startsWith("pt")) {
    return withFollowup
      ? "Não consegui validar seu número para enviar o SMS. Posso te ajudar com mais alguma coisa?"
      : "Não consegui validar seu número para enviar o SMS.";
  }

  return withFollowup
    ? "I could not validate your number to send the SMS. Can I help you with anything else?"
    : "I could not validate your number to send the SMS.";
}

function buildInvalidFromText(
  locale: VoiceLocale,
  withFollowup: boolean
): string {
  if (locale.startsWith("es")) {
    return withFollowup
      ? "No hay un número SMS válido configurado para enviar la confirmación. ¿Te ayudo con algo más?"
      : "No hay un número SMS válido configurado para enviar la confirmación.";
  }

  if (locale.startsWith("pt")) {
    return withFollowup
      ? "Não há um número SMS válido configurado para enviar a confirmação. Posso te ajudar com mais alguma coisa?"
      : "Não há um número SMS válido configurado para enviar a confirmação.";
  }

  return withFollowup
    ? "There is no valid SMS number configured to send the confirmation. Can I help you with anything else?"
    : "There is no valid SMS number configured to send the confirmation.";
}

function buildWhatsappOnlyText(
  locale: VoiceLocale,
  withFollowup: boolean
): string {
  if (locale.startsWith("es")) {
    return withFollowup
      ? "El número configurado es WhatsApp y no puede enviar SMS. ¿Te ayudo con algo más?"
      : "El número configurado es WhatsApp y no puede enviar SMS.";
  }

  if (locale.startsWith("pt")) {
    return withFollowup
      ? "O número configurado é apenas WhatsApp e não pode enviar SMS. Posso te ajudar com mais alguma coisa?"
      : "O número configurado é apenas WhatsApp e não pode enviar SMS.";
  }

  return withFollowup
    ? "The configured number is WhatsApp-only and cannot send SMS. Can I help you with anything else?"
    : "The configured number is WhatsApp-only and cannot send SMS.";
}

function buildSuccessFollowupText(locale: VoiceLocale): string {
  if (locale.startsWith("es")) {
    return "Te acabo de enviar los detalles de tu reserva por SMS. ¿Necesitas algo más?";
  }

  if (locale.startsWith("pt")) {
    return "Acabei de te enviar os detalhes da sua reserva por SMS. Posso te ajudar com mais alguma coisa?";
  }

  return "I just sent your booking details by SMS. Do you need anything else?";
}

function buildSuccessAppendText(locale: VoiceLocale): string {
  if (locale.startsWith("es")) {
    return " Te acabo de enviar los detalles por SMS.";
  }

  if (locale.startsWith("pt")) {
    return " Acabei de te enviar os detalhes por SMS.";
  }

  return " I just sent you the booking details by SMS.";
}

async function persistSmsSentState(params: {
  tenantId: string;
  callSid: string;
  state: CallState;
  currentLocale: VoiceLocale;
}): Promise<CallState> {
  const nextState: CallState = {
    ...params.state,
    awaiting: false,
    pendingType: null,
    smsSent: true,
  };

  await upsertVoiceCallState({
    callSid: params.callSid,
    tenantId: params.tenantId,
    lang: nextState.lang ?? params.currentLocale,
    turn: nextState.turn ?? 0,
    awaiting: false,
    pendingType: null,
    awaitingNumber: nextState.awaitingNumber ?? false,
    altDest: nextState.altDest ?? null,
    smsSent: true,
    bookingStepIndex: nextState.bookingStepIndex ?? null,
    bookingData: nextState.bookingData ?? {},
  });

  return nextState;
}

export async function sendBookingConfirmationSms(
  params: SendBookingConfirmationSmsParams
): Promise<SendBookingConfirmationSmsResult> {
  const {
    tenant,
    callSid,
    currentLocale,
    voiceName,
    state,
    bookingSmsPayload,
    callerE164,
    didNumber,
    vr,
    logBotSay,
    successMode,
  } = params;

  const smsFrom = tenant.twilio_sms_number || tenant.twilio_voice_number || "";
  const toDest =
    (state.altDest && isValidE164(state.altDest) ? state.altDest : null) ||
    callerE164;

  const body = buildBookingConfirmationSmsBody(bookingSmsPayload, currentLocale);

  console.log("[VOICE][BOOKING_SMS][UNIFIED_SEND_ATTEMPT]", {
    callSid,
    tenantId: tenant.id,
    smsFrom,
    toDest,
    body,
    successMode,
  });

  const withFollowup = successMode === "direct_followup";

  if (!toDest || !isValidE164(toDest)) {
    const bad = buildInvalidNumberText(currentLocale, withFollowup);

    if (successMode === "direct_followup") {
      const gather = vr.gather(
        buildVoiceGatherConfig({
          locale: currentLocale,
          action: "/webhook/voice-response",
          numDigits: 1,
          timeout: 7,
          bargeIn: true,
        })
      );

      gather.say({ language: currentLocale as any, voice: voiceName }, bad);

      return {
        sent: false,
        updatedState: state,
        twiml: vr.toString(),
      };
    }

    return {
      sent: false,
      updatedState: state,
      appendedText: ` ${bad}`,
    };
  }

  if (!smsFrom) {
    const bad = buildInvalidFromText(currentLocale, withFollowup);

    if (successMode === "direct_followup") {
      const gather = vr.gather(
        buildVoiceGatherConfig({
          locale: currentLocale,
          action: "/webhook/voice-response",
          numDigits: 1,
          timeout: 7,
          bargeIn: true,
        })
      );

      gather.say({ language: currentLocale as any, voice: voiceName }, bad);

      return {
        sent: false,
        updatedState: state,
        twiml: vr.toString(),
      };
    }

    return {
      sent: false,
      updatedState: state,
      appendedText: ` ${bad}`,
    };
  }

  if (smsFrom.startsWith("whatsapp:")) {
    const bad = buildWhatsappOnlyText(currentLocale, withFollowup);

    if (successMode === "direct_followup") {
      const gather = vr.gather(
        buildVoiceGatherConfig({
          locale: currentLocale,
          action: "/webhook/voice-response",
          numDigits: 1,
          timeout: 7,
          bargeIn: true,
        })
      );

      gather.say({ language: currentLocale as any, voice: voiceName }, bad);

      return {
        sent: false,
        updatedState: state,
        twiml: vr.toString(),
      };
    }

    return {
      sent: false,
      updatedState: state,
      appendedText: ` ${bad}`,
    };
  }

  const sentCount = await sendSMS({
    mensaje: body,
    destinatarios: [toDest],
    fromNumber: smsFrom || undefined,
    tenantId: tenant.id,
    campaignId: null,
  });

  console.log("[VOICE][BOOKING_SMS][UNIFIED_SENT]", {
    callSid,
    tenantId: tenant.id,
    sentCount,
    toDest,
  });

  const updatedState = await persistSmsSentState({
    tenantId: tenant.id,
    callSid,
    state,
    currentLocale,
  });

  if (successMode === "direct_followup") {
    const ok = buildSuccessFollowupText(currentLocale);

    const gather = vr.gather(
      buildVoiceGatherConfig({
        locale: currentLocale,
        action: "/webhook/voice-response",
        numDigits: 1,
        timeout: 7,
        bargeIn: true,
      })
    );

    gather.say({ language: currentLocale as any, voice: voiceName }, ok);

    logBotSay({
      callSid,
      to: didNumber || "ivr",
      text: ok,
      lang: currentLocale,
      context: "booking_sms_unified_sent_followup",
    });

    return {
      sent: true,
      updatedState,
      twiml: vr.toString(),
    };
  }

  return {
    sent: true,
    updatedState,
    appendedText: buildSuccessAppendText(currentLocale),
  };
}