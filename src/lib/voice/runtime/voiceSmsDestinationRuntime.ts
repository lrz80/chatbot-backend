//src/lib/voice/runtime/voiceSmsDestinationRuntime.ts
import { twiml } from "twilio";
import { upsertVoiceCallState } from "../upsertVoiceCallState";
import { renderVoiceReply } from "../renderVoiceReply";
import { renderVoiceSmsConfirmation } from "../renderVoiceSmsConfirmation";
import type { CallState, LinkType, VoiceLocale } from "../types";
import { isValidE164, maskForVoice } from "./voiceSmsRuntime";

type AskForSmsDestinationParams = {
  vr: twiml.VoiceResponse;
  tenantId: string;
  callSid: string;
  currentLocale: VoiceLocale;
  voiceName: any;
  state: CallState;
  smsType: LinkType;
};

type ConfirmSmsDestinationParams = {
  vr: twiml.VoiceResponse;
  tenantId: string;
  callSid: string;
  currentLocale: VoiceLocale;
  voiceName: any;
  state: CallState;
  smsType: LinkType;
  preferredDestination: string;
};

export async function askForSmsDestinationNumber(
  params: AskForSmsDestinationParams
): Promise<string> {
  const {
    vr,
    tenantId,
    callSid,
    currentLocale,
    voiceName,
    state,
    smsType,
  } = params;

  const askNum = renderVoiceReply("sms_ask_destination_number", {
    locale: currentLocale,
    linkType: smsType,
  });

  await upsertVoiceCallState({
    callSid,
    tenantId,
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
    input: ["speech", "dtmf"] as any,
    numDigits: 15,
    action: "/webhook/voice-response",
    method: "POST",
    language: currentLocale as any,
    speechTimeout: "auto",
    timeout: 10,
    actionOnEmptyResult: true,
    bargeIn: true,
    enhanced: true,
    speechModel: "phone_call",
    hints: currentLocale.startsWith("es")
      ? "más, mas, signo, uno, dos, tres, cuatro, cinco, seis, siete, ocho, nueve, cero, guion, espacio"
      : "plus, one, two, three, four, five, six, seven, eight, nine, zero, dash, space",
  });

  return vr.toString();
}

export async function confirmSmsDestinationNumber(
  params: ConfirmSmsDestinationParams
): Promise<string> {
  const {
    vr,
    tenantId,
    callSid,
    currentLocale,
    voiceName,
    state,
    smsType,
    preferredDestination,
  } = params;

  const confirm = renderVoiceSmsConfirmation(
    currentLocale,
    maskForVoice(preferredDestination)
  );

  await upsertVoiceCallState({
    callSid,
    tenantId,
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
    input: ["speech", "dtmf"] as any,
    numDigits: 15,
    action: "/webhook/voice-response",
    method: "POST",
    language: currentLocale as any,
    speechTimeout: "auto",
    timeout: 7,
    actionOnEmptyResult: true,
  });

  return vr.toString();
}

export function resolvePreferredSmsDestination(
  state: CallState,
  callerE164: string | null
): string | null {
  return (state.altDest && isValidE164(state.altDest) ? state.altDest : null) || callerE164;
}