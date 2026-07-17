// src/lib/voice/voiceBookingBusyRecovery.ts
import { twiml } from "twilio";
import { upsertVoiceCallState } from "./upsertVoiceCallState";
import type { CallState, VoiceLocale } from "./types";
import {
  buildBookingSlotBusyRecovery,
} from "../appointments/booking/runtime/buildBookingSlotBusyRecovery";

type BookingFlowStep = {
  step_key: string;
  prompt?: string | null;
  prompt_translations?: Record<string, string> | null;
  retry_prompt?: string | null;
  retry_prompt_translations?: Record<string, string> | null;
  validation_config?: Record<string, any> | null;
};

type HandleBookingSlotBusyRecoveryParams = {
  vr: twiml.VoiceResponse;
  flow: BookingFlowStep[];
  state: CallState;
  tenantId: string;
  callSid: string;
  currentLocale: VoiceLocale;
  voiceName: string;
  didNumber: string;
  callerE164: string | null;
  timeZone: string;
  suggestedStarts: string[];
  logBotSay: (input: {
    callSid: string;
    to: string;
    text: string;
    lang?: string;
    context?: string;
  }) => void;
};

export type ExecuteCanonicalBookingSlotBusyRecoveryParams = {
  flow: BookingFlowStep[];
  state: CallState;
  tenantId: string;
  callSid: string;
  currentLocale: VoiceLocale;
  callerE164: string | null;
  timeZone: string;
  suggestedStarts: string[];
};

export type ExecuteCanonicalBookingSlotBusyRecoveryResult = {
  state: CallState;
  prompt: string;
  context: "booking_busy_retry:datetime";
  datetimeStepIndex: number;
};

function createBookingGather(params: {
  vr: twiml.VoiceResponse;
  locale: VoiceLocale;
}) {
  return params.vr.gather({
    input: ["speech"] as any,
    action: "/webhook/voice-response",
    method: "POST",
    language: params.locale as any,
    speechTimeout: "1",
    timeout: 5,
    actionOnEmptyResult: true,
    bargeIn: true,
  });
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export async function executeCanonicalBookingSlotBusyRecovery(
  params: ExecuteCanonicalBookingSlotBusyRecoveryParams
): Promise<ExecuteCanonicalBookingSlotBusyRecoveryResult> {
  const {
    flow,
    state,
    tenantId,
    callSid,
    currentLocale,
    callerE164,
    timeZone,
    suggestedStarts,
  } = params;

  const recovery =
    buildBookingSlotBusyRecovery({
      flow,
      state,
      currentLocale,
      callerPhone: callerE164,
      timeZone,
      suggestedStarts,
    });

  await upsertVoiceCallState({
    callSid,
    tenantId,
    lang:
      recovery.state.lang ??
      currentLocale,
    turn: recovery.state.turn ?? 0,
    awaiting: false,
    pendingType: null,
    awaitingNumber: false,
    altDest:
      recovery.state.altDest ?? null,
    smsSent: false,
    bookingStepIndex:
      recovery.datetimeStepIndex,
    bookingData:
      recovery.state.bookingData || {},
  });

  return {
    state: recovery.state,
    prompt: recovery.prompt,
    context:
      "booking_busy_retry:datetime",
    datetimeStepIndex:
      recovery.datetimeStepIndex,
  };
}

export async function handleBookingSlotBusyRecovery(
  params: HandleBookingSlotBusyRecoveryParams
): Promise<{ state: CallState; twiml: string }> {
  const canonical = await executeCanonicalBookingSlotBusyRecovery({
    flow: params.flow,
    state: params.state,
    tenantId: params.tenantId,
    callSid: params.callSid,
    currentLocale: params.currentLocale,
    callerE164: params.callerE164,
    timeZone: params.timeZone,
    suggestedStarts: params.suggestedStarts,
  });

  const gather = createBookingGather({
    vr: params.vr,
    locale: params.currentLocale,
  });

  gather.say(
    { language: params.currentLocale as any, voice: params.voiceName as any },
    canonical.prompt
  );

  params.logBotSay({
    callSid: params.callSid,
    to: params.didNumber || "ivr",
    text: canonical.prompt,
    lang: params.currentLocale,
    context: canonical.context,
  });

  return {
    state: canonical.state,
    twiml: params.vr.toString(),
  };
}