//src/lib/voice/runtime/renderFinalVoiceTurn.ts
import { twiml } from "twilio";

import { deleteVoiceCallState } from "../deleteVoiceCallState";
import { resolveVoiceConversationClosure } from "../resolveVoiceConversationClosure";
import { renderVoiceLifecycle } from "../renderVoiceLifecycle";
import {
  normalizeSpeechOutput,
  sanitizeForSay,
  twoSentencesMax,
} from "../speechFormatting";

import type { CallState, VoiceLocale } from "../types";
import { buildVoiceGatherConfig } from "../buildVoiceGatherConfig";

type RenderFinalVoiceTurnParams = {
  vr: twiml.VoiceResponse;
  callSid: string;
  state: CallState;
  currentLocale: VoiceLocale;
  voiceName: string;
  didNumber: string;
  effectiveUserInput: string;
  respuesta: string;
  logBotSay: (args: {
    callSid: string;
    to: string;
    text: string;
    lang?: string;
    context?: string;
  }) => void;
};

type RenderFinalVoiceTurnResult = {
  handled: true;
  twiml: string;
};

export async function renderFinalVoiceTurn({
  vr,
  callSid,
  state,
  currentLocale,
  voiceName,
  didNumber,
  effectiveUserInput,
  respuesta,
  logBotSay,
}: RenderFinalVoiceTurnParams): Promise<RenderFinalVoiceTurnResult> {
  const hasActiveBookingStep = typeof state.bookingStepIndex === "number";

  const conversationClosure = await resolveVoiceConversationClosure(
    effectiveUserInput,
    currentLocale
  );

  const shouldEndCall =
    !hasActiveBookingStep &&
    conversationClosure.shouldClose;

  const speakOut = sanitizeForSay(
    normalizeSpeechOutput(twoSentencesMax(respuesta), currentLocale as any)
  );

  logBotSay({
    callSid,
    to: didNumber,
    text: speakOut,
    lang: currentLocale as any,
    context: "final-say",
  });

  if (!shouldEndCall) {
        const contGather = vr.gather(
      buildVoiceGatherConfig({
        locale: currentLocale,
        action: "/webhook/voice-response",
        numDigits: 1,
        timeout: 7,
        bargeIn: true,
      })
    );

    contGather.say(
      { language: currentLocale as any, voice: voiceName as any },
      speakOut
    );

    return {
      handled: true,
      twiml: vr.toString(),
    };
  }

  await deleteVoiceCallState(callSid);

  vr.say(
    { language: currentLocale as any, voice: voiceName as any },
    renderVoiceLifecycle("call_goodbye", currentLocale)
  );

  vr.hangup();

  return {
    handled: true,
    twiml: vr.toString(),
  };
}