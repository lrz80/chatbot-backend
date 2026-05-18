// src/lib/voice/booking/handleBookingConfirmationStep.ts
import { twiml } from "twilio";
import {
  resolveBookingFlowSpeech,
  resolveBookingRetryText,
} from "../voiceBookingHelpers";
import { twoSentencesMax } from "../speechFormatting";
import { handleBookingSlotBusyRecovery } from "../voiceBookingBusyRecovery";
import { assertNonEmptyBookingSpeech } from "./bookingSpeech";
import { resolveConfirmationMetaSignal } from "./confirmation/resolveConfirmationMetaSignal";
import { resolveSmsDestination } from "./confirmation/resolveSmsDestination";
import { createConfirmedVoiceAppointment } from "./confirmation/createConfirmedVoiceAppointment";
import type {
  BookingFlow,
  BookingStep,
  BookingStepHandlerResult,
  CreateBookingGatherFn,
  VoiceBotSayLogger,
} from "./types";
import type { CallState, VoiceLocale } from "../types";

type HandleBookingConfirmationStepParams = {
  vr: twiml.VoiceResponse;
  tenant: any;
  cfg: any;
  flow: BookingFlow;
  currentStep: BookingStep;
  currentLocale: VoiceLocale;
  voiceName: any;
  callSid: string;
  didNumber: string;
  callerE164: string | null;
  userInput: string;
  digits: string;
  state: CallState;
  createBookingGather: CreateBookingGatherFn;
  logBotSay: VoiceBotSayLogger;
  upsertVoiceCallState: typeof import("../upsertVoiceCallState").upsertVoiceCallState;
};

export type CanonicalBookingConfirmationStepParams = {
  tenant: any;
  cfg: any;
  flow: BookingFlow;
  currentStep: BookingStep;
  currentLocale: VoiceLocale;
  callSid: string;
  didNumber: string;
  callerE164: string | null;
  userInput: string;
  digits: string;
  state: CallState;
  upsertVoiceCallState: typeof import("../upsertVoiceCallState").upsertVoiceCallState;
};

export type CanonicalBookingConfirmationStepResult =
  | {
      kind: "pass_through";
      state: CallState;
    }
  | {
      kind: "retry";
      state: CallState;
      prompt: string;
      context: "confirmation_retry" | "offer_sms_retry";
    }
  | {
      kind: "cancelled";
      state: CallState;
      prompt: string;
      context: "booking_cancel_followup" | "booking_offer_sms_reject";
    }
  | {
      kind: "awaiting_sms_destination";
      state: CallState;
    }
  | {
      kind: "success";
      state: CallState;
      prompt: string;
      context: "booking_success";
    }
  | {
      kind: "success_offer_sms";
      state: CallState;
      successPrompt: string;
      smsOfferPrompt: string;
      context: "booking_success_offer_sms";
    }
  | {
      kind: "busy_recovery";
      state: CallState;
      busyRecovery: {
        timeZone: string;
        suggestedStarts: string[];
      };
    }
  | {
      kind: "failed";
      state: CallState;
      prompt: string;
      context: "booking_create_failed_keep_call_alive";
    };

function resolveSmsAcceptedPrompt(currentLocale: VoiceLocale): string {
  if (currentLocale.startsWith("es")) {
    return "Perfecto, te enviaré los detalles por SMS a este número.";
  }

  if (currentLocale.startsWith("pt")) {
    return "Perfeito, vou enviar os detalhes por SMS para este número.";
  }

  return "Perfect, I will send the booking details by SMS to this number.";
}

function resolveSmsAcceptedStateText(currentLocale: VoiceLocale): string {
  if (currentLocale.startsWith("es")) {
    return "Cliente aceptó recibir los detalles por SMS.";
  }

  if (currentLocale.startsWith("pt")) {
    return "O cliente aceitou receber os detalhes por SMS.";
  }

  return "Customer accepted receiving the booking details by SMS.";
}

function resolveBookingCreateFailedPrompt(params: {
  cfg: any;
  currentLocale: VoiceLocale;
}): string {
  const { cfg, currentLocale } = params;

  const configured =
    typeof cfg?.booking_error_message === "string" &&
    cfg.booking_error_message.trim()
      ? cfg.booking_error_message.trim()
      : "";

  if (configured) {
    return twoSentencesMax(configured);
  }

  if (currentLocale.startsWith("es")) {
    return "No pude completar la reserva en este momento. ¿Quieres que te ayude con otra cosa?";
  }

  if (currentLocale.startsWith("pt")) {
    return "Não consegui concluir a reserva neste momento. Posso te ajudar com mais alguma coisa?";
  }

  return "I could not complete the booking right now. Can I help you with anything else?";
}

async function persistVoiceBookingState(params: {
  tenantId: string;
  callSid: string;
  currentLocale: VoiceLocale;
  state: CallState;
  upsertVoiceCallState: HandleBookingConfirmationStepParams["upsertVoiceCallState"];
}): Promise<void> {
  const { tenantId, callSid, currentLocale, state, upsertVoiceCallState } =
    params;

  await upsertVoiceCallState({
    callSid,
    tenantId,
    lang: state.lang ?? currentLocale,
    turn: state.turn ?? 0,
    awaiting: state.awaiting ?? false,
    pendingType: state.pendingType ?? null,
    awaitingNumber: state.awaitingNumber ?? false,
    altDest: state.altDest ?? null,
    smsSent: state.smsSent ?? false,
    bookingStepIndex:
      typeof state.bookingStepIndex === "number" ? state.bookingStepIndex : null,
    bookingData: state.bookingData || {},
  });
}

function buildCancelPrompt(params: {
  currentStep: BookingStep;
  currentLocale: VoiceLocale;
  bookingData: CallState["bookingData"];
  callerE164: string | null;
}): string {
  const { currentStep, currentLocale, bookingData, callerE164 } = params;

  const cancelMessageTemplate =
    typeof currentStep.validation_config?.cancel_message === "string"
      ? currentStep.validation_config.cancel_message.trim()
      : "";

  const cancelMessageResolved = resolveBookingFlowSpeech({
    baseText: cancelMessageTemplate,
    locale: currentLocale,
    bookingData: bookingData || {},
    callerE164,
  });

  return twoSentencesMax(
    assertNonEmptyBookingSpeech({
      text: cancelMessageResolved,
      stepKey: currentStep.step_key,
      field: "prompt",
    })
  );
}

function buildRetryPrompt(params: {
  currentStep: BookingStep;
  currentLocale: VoiceLocale;
  bookingData: CallState["bookingData"];
  callerE164: string | null;
}): string {
  const { currentStep, currentLocale, bookingData, callerE164 } = params;

  const retryText = resolveBookingRetryText({
    locale: currentLocale,
    retryPrompt: currentStep.retry_prompt || "",
    retryPromptTranslations: currentStep.retry_prompt_translations || null,
    fallbackPrompt: currentStep.prompt || "",
    fallbackPromptTranslations: currentStep.prompt_translations || null,
  });

  return twoSentencesMax(
    resolveBookingFlowSpeech({
      baseText: retryText,
      locale: currentLocale,
      bookingData: bookingData || {},
      callerE164,
    })
  );
}

export async function executeCanonicalBookingConfirmationStep(
  params: CanonicalBookingConfirmationStepParams
): Promise<CanonicalBookingConfirmationStepResult> {
  const {
    tenant,
    cfg,
    flow,
    currentStep,
    currentLocale,
    callSid,
    callerE164,
    userInput,
    digits,
    state,
    upsertVoiceCallState,
  } = params;

  const confirmationMetaSignal = await resolveConfirmationMetaSignal({
    digits,
    userInput,
    currentLocale,
  });

  const rawSlot =
    typeof currentStep.validation_config?.slot === "string"
      ? currentStep.validation_config.slot.trim()
      : "";

  const isBookingConfirmationStep =
    rawSlot === "confirmation" || currentStep.step_key === "confirm";

  const isOfferBookingSmsStep = currentStep.step_key === "offer_booking_sms";

  if (isOfferBookingSmsStep) {
    if (confirmationMetaSignal.intent === "affirm") {
      const preservedBookingSmsPayload =
        typeof state.bookingData?.booking_sms_payload === "string"
          ? state.bookingData.booking_sms_payload
          : "";

      const smsDestination = resolveSmsDestination({
        state,
        callerE164,
      });

      if (smsDestination) {
        const spokenPrompt = resolveSmsAcceptedPrompt(currentLocale);

        const postBookingStateData = {
          ...(state.bookingData || {}),
          booking_sms_payload: preservedBookingSmsPayload,
          customer_phone:
            String(state.bookingData?.customer_phone || "").trim() ||
            smsDestination,
          __last_voice_domain: "booking",
          __last_booking_outcome: "confirmed",
          __last_assistant_text: spokenPrompt,
        };

        const nextState: CallState = {
          ...state,
          awaiting: false,
          pendingType: null,
          awaitingNumber: false,
          smsSent: false,
          bookingStepIndex: undefined,
          altDest: smsDestination,
          bookingData: postBookingStateData,
        };

        await persistVoiceBookingState({
          tenantId: tenant.id,
          callSid,
          currentLocale,
          state: nextState,
          upsertVoiceCallState,
        });

        return {
          kind: "success",
          state: nextState,
          prompt: spokenPrompt,
          context: "booking_success",
        };
      }

      const postBookingStateData = {
        ...(state.bookingData || {}),
        booking_sms_payload: preservedBookingSmsPayload,
        __last_voice_domain: "booking",
        __last_booking_outcome: "confirmed",
        __last_assistant_text: resolveSmsAcceptedStateText(currentLocale),
      };

      const nextState: CallState = {
        ...state,
        awaiting: true,
        pendingType: "reservar",
        awaitingNumber: true,
        smsSent: false,
        bookingStepIndex: undefined,
        bookingData: postBookingStateData,
      };

      await persistVoiceBookingState({
        tenantId: tenant.id,
        callSid,
        currentLocale,
        state: nextState,
        upsertVoiceCallState,
      });

      return {
        kind: "awaiting_sms_destination",
        state: nextState,
      };
    }

    if (confirmationMetaSignal.intent === "reject") {
      const spokenPrompt = buildCancelPrompt({
        currentStep,
        currentLocale,
        bookingData: state.bookingData,
        callerE164,
      });

      const postBookingStateData = {
        ...(state.bookingData || {}),
        __last_voice_domain: "booking",
        __last_booking_outcome: "confirmed",
        __last_assistant_text: spokenPrompt,
      };

      const nextState: CallState = {
        ...state,
        awaiting: false,
        pendingType: null,
        awaitingNumber: false,
        smsSent: false,
        bookingStepIndex: undefined,
        bookingData: postBookingStateData,
      };

      await persistVoiceBookingState({
        tenantId: tenant.id,
        callSid,
        currentLocale,
        state: nextState,
        upsertVoiceCallState,
      });

      return {
        kind: "cancelled",
        state: nextState,
        prompt: spokenPrompt,
        context: "booking_offer_sms_reject",
      };
    }

    const retry = buildRetryPrompt({
      currentStep,
      currentLocale,
      bookingData: state.bookingData,
      callerE164,
    });

    return {
      kind: "retry",
      state,
      prompt: retry,
      context: "offer_sms_retry",
    };
  }

  if (!isBookingConfirmationStep) {
    return {
      kind: "pass_through",
      state,
    };
  }

  if (confirmationMetaSignal.intent === "affirm") {
    try {
      const confirmed = await createConfirmedVoiceAppointment({
        tenant,
        cfg,
        flow,
        currentLocale,
        callSid,
        callerE164,
        state,
      });

      if (confirmed.smsOfferPrompt) {
        const nextState: CallState = {
          ...state,
          awaiting: false,
          pendingType: null,
          awaitingNumber: false,
          smsSent: false,
          bookingStepIndex: confirmed.successStepIndex + 1,
          bookingData: {
            ...confirmed.bookingSpeechData,
            booking_sms_payload: confirmed.bookingSmsPayloadJson,
          },
        };

        await persistVoiceBookingState({
          tenantId: tenant.id,
          callSid,
          currentLocale,
          state: nextState,
          upsertVoiceCallState,
        });

        return {
          kind: "success_offer_sms",
          state: nextState,
          successPrompt: confirmed.successPrompt,
          smsOfferPrompt: confirmed.smsOfferPrompt,
          context: "booking_success_offer_sms",
        };
      }

      const nextState: CallState = {
        ...state,
        awaiting: false,
        pendingType: null,
        awaitingNumber: false,
        smsSent: false,
        bookingStepIndex: undefined,
        bookingData: {
          ...confirmed.bookingSpeechData,
          booking_sms_payload: confirmed.bookingSmsPayloadJson,
          __last_voice_domain: "booking",
          __last_booking_outcome: "confirmed",
          __last_assistant_text: confirmed.successPrompt,
        },
      };

      await persistVoiceBookingState({
        tenantId: tenant.id,
        callSid,
        currentLocale,
        state: nextState,
        upsertVoiceCallState,
      });

      return {
        kind: "success",
        state: nextState,
        prompt: confirmed.successPrompt,
        context: "booking_success",
      };
    } catch (err: any) {
      console.error("❌ Error creando cita:", err);

      const providerError =
        err?.error || err?.code || err?.providerError || null;

      const suggestedStarts: string[] = Array.isArray(err?.suggestedStarts)
        ? err.suggestedStarts
        : [];

      if (providerError === "SLOT_BUSY") {
        const postBusyState: CallState = {
          ...state,
          awaiting: false,
          pendingType: null,
          awaitingNumber: false,
          smsSent: false,
        };

        return {
          kind: "busy_recovery",
          state: postBusyState,
          busyRecovery: {
            timeZone:
              typeof err?.bookingTimeZone === "string" &&
              err.bookingTimeZone.trim()
                ? err.bookingTimeZone.trim()
                : "America/New_York",
            suggestedStarts,
          },
        };
      }

      const failPrompt = resolveBookingCreateFailedPrompt({
        cfg,
        currentLocale,
      });

      const postBookingStateData = {
        ...(state.bookingData || {}),
        __last_voice_domain: "booking",
        __last_booking_outcome: "failed",
        __last_booking_error:
          err?.error ||
          err?.code ||
          err?.providerError ||
          err?.message ||
          "BOOKING_FAILED",
        __last_assistant_text: failPrompt,
      };

      const nextState: CallState = {
        ...state,
        awaiting: false,
        pendingType: null,
        awaitingNumber: false,
        smsSent: false,
        bookingStepIndex: undefined,
        bookingData: postBookingStateData,
      };

      await persistVoiceBookingState({
        tenantId: tenant.id,
        callSid,
        currentLocale,
        state: nextState,
        upsertVoiceCallState,
      });

      return {
        kind: "failed",
        state: nextState,
        prompt: failPrompt,
        context: "booking_create_failed_keep_call_alive",
      };
    }
  }

  if (confirmationMetaSignal.intent === "reject") {
    const cancelPrompt = buildCancelPrompt({
      currentStep,
      currentLocale,
      bookingData: state.bookingData,
      callerE164,
    });

    const spokenPrompt = assertNonEmptyBookingSpeech({
      text: cancelPrompt,
      stepKey: currentStep.step_key,
      field: "prompt",
    });

    const postBookingStateData = {
      __last_voice_domain: "booking",
      __last_booking_outcome: "cancelled",
      __last_assistant_text: spokenPrompt,
    };

    const nextState: CallState = {
      ...state,
      awaiting: false,
      pendingType: null,
      awaitingNumber: false,
      smsSent: false,
      bookingStepIndex: undefined,
      bookingData: postBookingStateData,
    };

    await persistVoiceBookingState({
      tenantId: tenant.id,
      callSid,
      currentLocale,
      state: nextState,
      upsertVoiceCallState,
    });

    return {
      kind: "cancelled",
      state: nextState,
      prompt: spokenPrompt,
      context: "booking_cancel_followup",
    };
  }

  const retry = buildRetryPrompt({
    currentStep,
    currentLocale,
    bookingData: state.bookingData,
    callerE164,
  });

  return {
    kind: "retry",
    state,
    prompt: retry,
    context: "confirmation_retry",
  };
}

export async function handleBookingConfirmationStep(
  params: HandleBookingConfirmationStepParams
): Promise<BookingStepHandlerResult> {
  const {
    vr,
    flow,
    currentLocale,
    voiceName,
    didNumber,
    callSid,
    createBookingGather,
    logBotSay,
  } = params;

  const canonical = await executeCanonicalBookingConfirmationStep({
    tenant: params.tenant,
    cfg: params.cfg,
    flow: params.flow,
    currentStep: params.currentStep,
    currentLocale: params.currentLocale,
    callSid: params.callSid,
    didNumber: params.didNumber,
    callerE164: params.callerE164,
    userInput: params.userInput,
    digits: params.digits,
    state: params.state,
    upsertVoiceCallState: params.upsertVoiceCallState,
  });

  if (canonical.kind === "pass_through") {
    return { handled: false, state: canonical.state };
  }

  if (canonical.kind === "awaiting_sms_destination") {
    return { handled: false, state: canonical.state };
  }

  if (canonical.kind === "busy_recovery") {
    const recovered = await handleBookingSlotBusyRecovery({
      vr,
      flow,
      state: canonical.state,
      tenantId: params.tenant.id,
      callSid: params.callSid,
      currentLocale: params.currentLocale,
      voiceName: params.voiceName,
      didNumber: params.didNumber,
      callerE164: params.callerE164,
      timeZone: canonical.busyRecovery.timeZone,
      suggestedStarts: canonical.busyRecovery.suggestedStarts,
      logBotSay: params.logBotSay,
    });

    return {
      handled: true,
      state: recovered.state,
      twiml: recovered.twiml,
    };
  }

  if (canonical.kind === "success_offer_sms") {
    const gather = createBookingGather({
      vr,
      locale: currentLocale,
      isConfirmationStep: true,
    });

    gather.say(
      { language: currentLocale as any, voice: voiceName },
      canonical.successPrompt
    );

    gather.say(
      { language: currentLocale as any, voice: voiceName },
      canonical.smsOfferPrompt
    );

    logBotSay({
      callSid,
      to: didNumber || "ivr",
      text: `${canonical.successPrompt} ${canonical.smsOfferPrompt}`,
      lang: currentLocale,
      context: canonical.context,
    });

    return {
      handled: true,
      state: canonical.state,
      twiml: vr.toString(),
    };
  }

  if (
    canonical.kind === "success" ||
    canonical.kind === "failed" ||
    canonical.kind === "cancelled" ||
    canonical.kind === "retry"
  ) {
    const gather = createBookingGather({
      vr,
      locale: currentLocale,
      isConfirmationStep: true,
    });

    gather.say(
      { language: currentLocale as any, voice: voiceName },
      canonical.prompt
    );

    logBotSay({
      callSid,
      to: didNumber || "ivr",
      text: canonical.prompt,
      lang: currentLocale,
      context: canonical.context,
    });

    return {
      handled: true,
      state: canonical.state,
      twiml: vr.toString(),
    };
  }

  return { handled: false, state: params.state };
}