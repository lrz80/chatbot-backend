//src/lib/voice/handlers/handleVoiceBookingEntry.ts
import { twiml } from "twilio";
import { handleVoiceBookingTurn } from "../handleVoiceBookingTurn";
import type { CallState } from "../types";

type VoiceLocale = "es-ES" | "en-US" | "pt-BR";

type HandleVoiceBookingEntryParams = {
  vr: twiml.VoiceResponse;
  effectiveUserInput: string;
  resolvedInitialVoiceIntent: string | null;
  state: CallState;
  tenant: any;
  cfg: any;
  callSid: string;
  didNumber: string;
  callerE164: string | null;
  currentLocale: VoiceLocale;
  voiceName: any;
  userInput: string;
  digits: string;
  logBotSay: (params: {
    callSid: string;
    to: string;
    text: string;
    lang?: string;
    context?: string;
  }) => void;
};

type HandleVoiceBookingEntryResult = {
  handled: boolean;
  twiml?: string;
  state: CallState;
};

export async function handleVoiceBookingEntry(
  params: HandleVoiceBookingEntryParams
): Promise<HandleVoiceBookingEntryResult> {
  const {
    vr,
    effectiveUserInput,
    resolvedInitialVoiceIntent,
    state,
    tenant,
    cfg,
    callSid,
    didNumber,
    callerE164,
    currentLocale,
    voiceName,
    userInput,
    digits,
    logBotSay,
  } = params;

  const shouldEnterBooking =
    !!effectiveUserInput &&
    (
      typeof state.bookingStepIndex === "number" ||
      resolvedInitialVoiceIntent === "booking"
    );

  if (!shouldEnterBooking) {
    return {
      handled: false,
      state,
    };
  }

  const bookingTurnResult = await handleVoiceBookingTurn({
    vr,
    tenant,
    cfg,
    callSid,
    didNumber,
    callerE164,
    currentLocale,
    voiceName,
    state,
    userInput,
    effectiveUserInput,
    digits,
    logBotSay,
  });

  if (bookingTurnResult.handled) {
    return {
      handled: true,
      twiml: bookingTurnResult.twiml,
      state: bookingTurnResult.state,
    };
  }

  return {
    handled: false,
    state: bookingTurnResult.state,
  };
}