//src/lib/voice/runtime/handleAwaitingSmsDestinationTurn.ts
import { twiml } from "twilio";
import { normalizarNumero } from "../../senders/sms";
import { extractDigits } from "../resolveVoiceTurnSignals";
import { renderVoiceReply } from "../renderVoiceReply";
import { upsertVoiceCallState } from "../upsertVoiceCallState";
import type { CallState, LinkType, VoiceLocale } from "../types";
import { wordsToDigits } from "../voiceBookingHelpers";
import { enviarSmsConLink, isValidE164 } from "./voiceSmsRuntime";

type TenantSmsConfig = {
  id: string;
  twilio_sms_number?: string | null;
};

type HandleAwaitingSmsDestinationTurnParams = {
  effectiveUserInput: string;
  digits: string;
  state: CallState;
  tenant: TenantSmsConfig;
  callSid: string;
  callerE164: string | null;
  callerRaw: string;
  currentLocale: VoiceLocale;
  voiceName: any;
};

export type HandleAwaitingSmsDestinationTurnResult =
  | {
      handled: false;
      updatedState: CallState;
    }
  | {
      handled: true;
      updatedState: CallState;
      twiml: string;
    };

export async function handleAwaitingSmsDestinationTurn(
  params: HandleAwaitingSmsDestinationTurnParams
): Promise<HandleAwaitingSmsDestinationTurnResult> {
  const {
    effectiveUserInput,
    digits,
    state,
    tenant,
    callSid,
    callerE164,
    callerRaw,
    currentLocale,
    voiceName,
  } = params;

  const hasActiveBookingStep = typeof state.bookingStepIndex === "number";

  if (hasActiveBookingStep || !state.awaitingNumber || (!effectiveUserInput && !digits)) {
    return {
      handled: false,
      updatedState: state,
    };
  }

  let rawDigits = digits || extractDigits(effectiveUserInput);

  if (!rawDigits) {
    const spoken = wordsToDigits(effectiveUserInput);
    rawDigits = extractDigits(spoken) || "";
  }

  let candidate = rawDigits ? `+${rawDigits.replace(/^\+/, "")}` : null;

  try {
    if (candidate) {
      candidate = normalizarNumero(candidate);
    }
  } catch {
    // no-op
  }

  if (!candidate || !isValidE164(candidate)) {
    const askAgain = renderVoiceReply("sms_invalid_destination_number", {
      locale: currentLocale,
    });

    const vrNum = new twiml.VoiceResponse();

    vrNum.say({ language: currentLocale as any, voice: voiceName }, askAgain);

    vrNum.gather({
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

    return {
      handled: true,
      updatedState: state,
      twiml: vrNum.toString(),
    };
  }

  const nextState: CallState = {
    ...state,
    altDest: candidate,
    awaitingNumber: false,
  };

  await upsertVoiceCallState({
    callSid,
    tenantId: tenant.id,
    lang: nextState.lang ?? currentLocale,
    turn: nextState.turn ?? 0,
    awaiting: nextState.awaiting ?? false,
    pendingType: nextState.pendingType ?? null,
    awaitingNumber: false,
    altDest: candidate,
    smsSent: nextState.smsSent ?? false,
    bookingStepIndex: nextState.bookingStepIndex ?? null,
    bookingData: nextState.bookingData ?? {},
  });

  const tipo: LinkType = nextState.pendingType || "web";

  try {
    await enviarSmsConLink(tipo, {
      tenantId: tenant.id,
      callerE164,
      callerRaw,
      smsFromCandidate: tenant.twilio_sms_number || "",
      callSid,
      overrideDestE164: candidate,
    });

    const ok = renderVoiceReply("sms_sent_success", {
      locale: currentLocale,
      linkType: tipo,
    });

    const vrOk = new twiml.VoiceResponse();

    vrOk.say({ language: currentLocale as any, voice: voiceName }, ok);

    vrOk.gather({
      input: ["speech", "dtmf"] as any,
      numDigits: 1,
      action: "/webhook/voice-response",
      method: "POST",
      language: currentLocale as any,
      speechTimeout: "auto",
      timeout: 7,
      actionOnEmptyResult: true,
    });

    return {
      handled: true,
      updatedState: {
        ...nextState,
        smsSent: true,
      },
      twiml: vrOk.toString(),
    };
  } catch {
    const bad = renderVoiceReply("sms_send_error", {
      locale: currentLocale,
    });

    const vrBad = new twiml.VoiceResponse();

    vrBad.say({ language: currentLocale as any, voice: voiceName }, bad);

    return {
      handled: true,
      updatedState: nextState,
      twiml: vrBad.toString(),
    };
  }
}