//src/lib/voice/runtime/sendVoiceLinkRuntime.ts
import pool from "../../db";
import { sendVoiceLinkSms } from "../sendVoiceLinkSms";
import { upsertVoiceCallState } from "../upsertVoiceCallState";
import { resolveVoiceSmsDeliveryOutcome } from "../resolveVoiceSmsDeliveryOutcome";
import type { CallState, LinkType, VoiceLocale } from "../types";

type TenantSmsConfig = {
  id: string;
  twilio_sms_number?: string | null;
  twilio_voice_number?: string | null;
};

type SendVoiceLinkWithStateParams = {
  tenant: TenantSmsConfig;
  callSid: string;
  state: CallState;
  currentLocale: VoiceLocale;
  smsType: LinkType;
  callerRaw: string;
  callerE164: string | null;
  overrideDestE164?: string | null;
  brand: string;
  channelKey: string;
};

export type SendVoiceLinkWithStateResult = {
  updatedState: CallState;
  appendText: string;
  sent: boolean;
};

export async function sendVoiceLinkWithState(
  params: SendVoiceLinkWithStateParams
): Promise<SendVoiceLinkWithStateResult> {
  const {
    tenant,
    callSid,
    state,
    currentLocale,
    smsType,
    callerRaw,
    callerE164,
    overrideDestE164,
    brand,
    channelKey,
  } = params;

  const result = await sendVoiceLinkSms({
    tenantId: tenant.id,
    smsType,
    callerRaw,
    callerE164,
    overrideDestE164: overrideDestE164 ?? null,
    smsFromCandidate:
      tenant.twilio_sms_number || tenant.twilio_voice_number || "",
    brand,
  });

  const smsDeliveryOutcome = resolveVoiceSmsDeliveryOutcome(result, currentLocale);

  if (!result.ok) {
    console.warn("[VOICE/SMS] No se pudo enviar el SMS:", result.code, result.message);

    return {
      updatedState: state,
      appendText: smsDeliveryOutcome.appendText,
      sent: false,
    };
  }

  console.log("[VOICE/SMS] sendSMS -> enviados =", result.sentCount);

  const updatedState: CallState = {
    ...state,
    awaiting: false,
    pendingType: null,
    smsSent: true,
  };

  await upsertVoiceCallState({
    callSid,
    tenantId: tenant.id,
    lang: updatedState.lang ?? currentLocale,
    turn: updatedState.turn ?? 0,
    awaiting: false,
    pendingType: null,
    awaitingNumber: updatedState.awaitingNumber ?? false,
    altDest: updatedState.altDest ?? null,
    smsSent: true,
    bookingStepIndex: updatedState.bookingStepIndex ?? null,
    bookingData: updatedState.bookingData ?? {},
  });

  await pool.query(
    `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number)
     VALUES ($1, 'system', $2, NOW(), $3, $4)`,
    [tenant.id, "SMS enviado con link único.", channelKey, result.smsFrom]
  );

  return {
    updatedState,
    appendText: smsDeliveryOutcome.appendText,
    sent: true,
  };
}