//src/lib/voice/runtime/voiceSmsRuntime.ts
import { twiml } from "twilio";
import { buildVoiceGatherConfig } from "../buildVoiceGatherConfig";
import pool from '../../../lib/db';
import { sendVoiceLinkSms } from "../sendVoiceLinkSms";
import { getVoiceCallState } from "../getVoiceCallState";
import { upsertVoiceCallState } from "../upsertVoiceCallState";
import { renderVoiceReply } from "../renderVoiceReply";
import type { CallState, LinkType, VoiceLocale } from "../types";

export function maskForVoice(n: string): string {
  return (n || "").replace(
    /^\+?(\d{0,3})\d{0,6}(\d{2})(\d{2})$/,
    (_, p, a, b) => `+${p || ""} *** ** ${a} ${b}`
  );
}

export function isValidE164(n?: string | null): boolean {
  return !!n && /^\+\d{10,15}$/.test(n);
}

export async function getTenantBrand(tenantId: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT NULLIF(TRIM(name), '') AS brand
       FROM tenants
      WHERE id = $1
      LIMIT 1`,
    [tenantId]
  );

  const brand = (rows?.[0]?.brand || "").toString().trim();
  return brand || "Aamy";
}

type SendVoiceLinkSmsParams = {
  tenantId: string;
  callerE164: string | null;
  callerRaw: string;
  smsFromCandidate: string | null;
  callSid: string;
  overrideDestE164?: string | null;
};

export async function enviarSmsConLink(
  tipo: LinkType,
  {
    tenantId,
    callerE164,
    callerRaw,
    smsFromCandidate,
    callSid,
    overrideDestE164,
  }: SendVoiceLinkSmsParams
): Promise<void> {
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
    [tenantId, "SMS enviado con link único.", "voice", result.smsFrom || "sms"]
  );
}

type OfferSmsParams = {
  vr: twiml.VoiceResponse;
  locale: VoiceLocale;
  voiceName: any;
  callSid: string;
  state: CallState;
  tipo: LinkType;
  tenantId: string;
  logBotSay: (params: {
    callSid: string;
    to: string;
    text: string;
    lang?: string;
    context?: string;
  }) => void;
};

export async function offerSms({
  vr,
  locale,
  voiceName,
  callSid,
  state,
  tipo,
  tenantId,
  logBotSay,
}: OfferSmsParams): Promise<void> {
  const ask = renderVoiceReply("sms_offer_confirmation", {
    locale,
    linkType: tipo,
  });

  const gather = vr.gather(
    buildVoiceGatherConfig({
      locale,
      action: "/webhook/voice-response",
      numDigits: 1,
      timeout: 7,
      bargeIn: true,
      hints: locale.startsWith("es") ? "sí, si, uno, 1" : "yes, one, 1",
    })
  );

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

  logBotSay({
    callSid,
    to: "ivr",
    text: ask,
    lang: locale,
    context: `offer-sms:${tipo}`,
  });
}