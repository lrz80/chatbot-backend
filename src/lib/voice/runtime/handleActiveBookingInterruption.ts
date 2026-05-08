//src/lib/voice/runtime/handleActiveBookingInterruption.ts
import { twiml } from "twilio";

import { upsertVoiceCallState } from "../upsertVoiceCallState";
import { deleteVoiceCallState } from "../deleteVoiceCallState";
import { resolveVoiceBusinessTopic } from "../resolveVoiceBusinessTopic";
import { resolveVoiceConversationClosure } from "../resolveVoiceConversationClosure";
import { resolveVoiceIntentFromUtteranceAsync } from "../resolveVoiceIntentFromUtterance";
import { resolveVoiceMetaSignal } from "../resolveVoiceMetaSignal";
import { renderVoiceReply } from "../renderVoiceReply";
import { renderVoiceLifecycle } from "../renderVoiceLifecycle";

import type { CallState, VoiceLocale } from "../types";

type TenantLike = {
  id: string;
  twilio_sms_number?: string | null;
};

type VoiceConfigLike = {
  representante_number?: string | null;
};

type HandleActiveBookingInterruptionParams = {
  vr: twiml.VoiceResponse;
  state: CallState;
  effectiveUserInput: string;
  tenant: TenantLike;
  cfg: VoiceConfigLike | null | undefined;
  callSid: string;
  didNumber: string;
  callerE164: string;
  callerRaw: string;
  currentLocale: VoiceLocale;
  voiceName: string;
  logBotSay: (args: {
    callSid: string;
    to: string;
    text: string;
    lang?: string;
    context?: string;
  }) => void;
  getBookingFlow: (tenantId: string) => Promise<any[]>;
  normalizarNumero: (value: string) => string;
  offerSms: (args: {
    vr: twiml.VoiceResponse;
    locale: VoiceLocale;
    voiceName: string;
    callSid: string;
    state: CallState;
    tipo: "soporte" | "ubicacion" | "horarios" | "reservar";
    tenantId: string;
    logBotSay: (args: {
      callSid: string;
      to: string;
      text: string;
      lang?: string;
      context?: string;
    }) => void;
  }) => Promise<void>;
  sendSupportSms: (args: {
    tenantId: string;
    callerE164: string;
    callerRaw: string;
    smsFromCandidate: string | null;
    callSid: string;
  }) => Promise<void>;
};

type HandleActiveBookingInterruptionResult =
  | {
      handled: false;
      state: CallState;
    }
  | {
      handled: true;
      state: CallState;
      twiml: string;
    };

function getStepSlot(step: any): string {
  return typeof step?.validation_config?.slot === "string"
    ? step.validation_config.slot.trim()
    : "";
}

function isConfirmationLikeStep(step: any, slot: string): boolean {
  return (
    step?.expected_type === "confirmation" ||
    step?.step_key === "offer_booking_sms" ||
    slot === "confirmation"
  );
}

function isTransactionalBookingStep(step: any, slot: string): boolean {
  return Boolean(
    step &&
      (
        slot === "datetime" ||
        slot === "service" ||
        slot === "location_detail" ||
        slot === "pet_weight" ||
        slot === "customer_name" ||
        slot === "customer_phone" ||
        step.step_key === "datetime" ||
        step.step_key === "service" ||
        step.step_key === "location_detail" ||
        step.step_key === "pet_weight" ||
        step.step_key === "customer_name" ||
        step.step_key === "customer_phone"
      )
  );
}

function preserveBookingDataForExit(
  bookingData: Record<string, any> | undefined
): Record<string, any> {
  const preserved: Record<string, any> = {};

  if (bookingData?.__voice_intro_played) {
    preserved.__voice_intro_played = bookingData.__voice_intro_played;
  }

  return preserved;
}

export async function handleActiveBookingInterruption(
  params: HandleActiveBookingInterruptionParams
): Promise<HandleActiveBookingInterruptionResult> {
  const {
    vr,
    state,
    effectiveUserInput,
    tenant,
    cfg,
    callSid,
    didNumber,
    callerE164,
    callerRaw,
    currentLocale,
    voiceName,
    logBotSay,
    getBookingFlow,
    normalizarNumero,
    offerSms,
    sendSupportSms,
  } = params;

  const hasActiveBookingFlow = typeof state.bookingStepIndex === "number";

  if (!hasActiveBookingFlow || !effectiveUserInput) {
    return {
      handled: false,
      state,
    };
  }

  const bookingFlow = await getBookingFlow(tenant.id);

  const activeBookingStep =
    typeof state.bookingStepIndex === "number"
      ? bookingFlow[state.bookingStepIndex]
      : null;

  const activeBookingSlot = getStepSlot(activeBookingStep);

  const confirmationLikeBookingStep = isConfirmationLikeStep(
    activeBookingStep,
    activeBookingSlot
  );

  const interruptionBusinessTopic =
    resolveVoiceBusinessTopic(effectiveUserInput);

  const interruptionVoiceIntent =
    await resolveVoiceIntentFromUtteranceAsync(effectiveUserInput, {
      timeoutMs: 1500,
      minConfidence: 0.65,
    });

  const interruptionClosure = await resolveVoiceConversationClosure(
    effectiveUserInput,
    currentLocale
  );

  const interruptionMetaSignal = interruptionBusinessTopic.matched
    ? { intent: "none" as const, confidence: 0 }
    : await resolveVoiceMetaSignal({
        utterance: effectiveUserInput,
        locale: currentLocale,
      });

  const transactionalBookingStep = isTransactionalBookingStep(
    activeBookingStep,
    activeBookingSlot
  );

  const shouldLeaveBookingForBusinessTopic =
    !transactionalBookingStep &&
    interruptionBusinessTopic.matched &&
    interruptionBusinessTopic.topic &&
    interruptionBusinessTopic.linkType;

  const shouldLeaveBookingForHumanHandoff =
    interruptionVoiceIntent === "human_handoff";

  const shouldCloseBooking =
    confirmationLikeBookingStep &&
    (
      interruptionClosure.shouldClose ||
      interruptionMetaSignal.intent === "close" ||
      interruptionMetaSignal.intent === "reject"
    );

  if (
    !shouldLeaveBookingForBusinessTopic &&
    !shouldLeaveBookingForHumanHandoff &&
    !shouldCloseBooking
  ) {
    return {
      handled: false,
      state,
    };
  }

  const preservedBookingData = preserveBookingDataForExit(state.bookingData);

  const updatedState: CallState = {
    ...state,
    awaiting: false,
    pendingType: null,
    awaitingNumber: false,
    bookingStepIndex: undefined,
    bookingData: preservedBookingData,
  };

  await upsertVoiceCallState({
    callSid,
    tenantId: tenant.id,
    lang: updatedState.lang ?? currentLocale,
    turn: updatedState.turn ?? 0,
    awaiting: false,
    pendingType: null,
    awaitingNumber: false,
    altDest: updatedState.altDest ?? null,
    smsSent: updatedState.smsSent ?? false,
    bookingStepIndex: null,
    bookingData: preservedBookingData,
  });

  if (shouldLeaveBookingForHumanHandoff) {
    const rawRepresentativeNumber = cfg?.representante_number || null;

    const representativeNumber = rawRepresentativeNumber
      ? normalizarNumero(String(rawRepresentativeNumber))
      : null;

    console.log("[VOICE][TRANSFER_TARGET]", {
      callSid,
      tenantId: tenant.id,
      didNumber,
      callerE164,
      rawRepresentanteNumber: rawRepresentativeNumber,
      normalizedRepresentanteNumber: representativeNumber,
    });

    if (representativeNumber) {
      const connectingText = renderVoiceReply("transfer_connecting", {
        locale: currentLocale,
      });

      vr.say(
        { language: currentLocale as any, voice: voiceName as any },
        connectingText
      );

      const dial = vr.dial({
        action: "/webhook/voice-response?transfer=1",
        method: "POST",
        timeout: 15,
        answerOnBridge: true,
        callerId: didNumber,
      });

      dial.number(representativeNumber);

      return {
        handled: true,
        state: updatedState,
        twiml: vr.toString(),
      };
    }

    const unavailableText = renderVoiceReply("transfer_unavailable", {
      locale: currentLocale,
    });

    vr.say(
      { language: currentLocale as any, voice: voiceName as any },
      unavailableText
    );

    await offerSms({
      vr,
      locale: currentLocale,
      voiceName,
      callSid,
      state: updatedState,
      tipo: "soporte",
      tenantId: tenant.id,
      logBotSay,
    });

    return {
      handled: true,
      state: updatedState,
      twiml: vr.toString(),
    };
  }

  console.log("[VOICE][BOOKING_INTERRUPTED]", {
    callSid,
    tenantId: tenant.id,
    reason: shouldLeaveBookingForBusinessTopic
      ? "business_topic"
      : shouldLeaveBookingForHumanHandoff
      ? "human_handoff"
      : "close_or_reject",
    userInput: effectiveUserInput,
    businessTopic: interruptionBusinessTopic,
    metaSignal: interruptionMetaSignal,
  });

  if (shouldCloseBooking && !shouldLeaveBookingForBusinessTopic) {
    await deleteVoiceCallState(callSid);

    vr.say(
      { language: currentLocale as any, voice: voiceName as any },
      renderVoiceLifecycle("call_goodbye", currentLocale)
    );

    vr.hangup();

    return {
      handled: true,
      state: updatedState,
      twiml: vr.toString(),
    };
  }

  if (shouldLeaveBookingForBusinessTopic) {
    return {
      handled: false,
      state: updatedState,
    };
  }

  if (shouldLeaveBookingForHumanHandoff && !cfg?.representante_number) {
    await sendSupportSms({
      tenantId: tenant.id,
      callerE164,
      callerRaw,
      smsFromCandidate: tenant.twilio_sms_number || null,
      callSid,
    });
  }

  return {
    handled: false,
    state: updatedState,
  };
}