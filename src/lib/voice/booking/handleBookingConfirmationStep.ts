// src/lib/voice/booking/handleBookingConfirmationStep.ts
import { twiml } from "twilio";
import pool from "../../db";
import { createAppointmentFromVoice } from "../../appointments/createAppointmentFromVoice";
import {
  buildAnswersBySlot,
  resolveBookingFlowSpeech,
  resolveBookingPromptText,
  resolveBookingRetryText,
  resolveBookingSuccessStep,
} from "../voiceBookingHelpers";
import { resolveVoiceMetaSignal } from "../resolveVoiceMetaSignal";
import { twoSentencesMax } from "../speechFormatting";
import { handleBookingSlotBusyRecovery } from "../voiceBookingBusyRecovery";
import {
  assertNonEmptyBookingSpeech,
  buildExtraBookingFields,
} from "./bookingSpeech";
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

type ConfirmationMetaSignal = {
  intent: "affirm" | "reject" | "none";
  confidence?: number;
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

async function resolveConfirmationMetaSignal(params: {
  digits: string;
  userInput: string;
  currentLocale: VoiceLocale;
}): Promise<ConfirmationMetaSignal> {
  const { digits, userInput, currentLocale } = params;

  if (digits === "1") {
    return { intent: "affirm", confidence: 1 };
  }

  if (digits === "2") {
    return { intent: "reject", confidence: 1 };
  }

  const resolved = await resolveVoiceMetaSignal({
    utterance: userInput,
    locale: currentLocale,
  });

  if (resolved.intent === "affirm") {
    return {
      intent: "affirm",
      confidence: resolved.confidence,
    };
  }

  if (resolved.intent === "reject") {
    return {
      intent: "reject",
      confidence: resolved.confidence,
    };
  }

  return {
    intent: "none",
    confidence: resolved.confidence,
  };
}

function resolveSmsDestination(params: {
  state: CallState;
  callerE164: string | null;
}): string {
  const { state, callerE164 } = params;

  const fromState = [
    state.bookingData?.customer_phone,
    state.bookingData?.phone,
    callerE164,
  ]
    .map((value) => String(value || "").trim())
    .find((value) => value.length >= 7);

  return fromState || "";
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
        const postBookingStateData = {
          ...(state.bookingData || {}),
          booking_sms_payload: preservedBookingSmsPayload,
          customer_phone:
            String(state.bookingData?.customer_phone || "").trim() || smsDestination,
          __last_voice_domain: "booking",
          __last_booking_outcome: "confirmed",
          __last_assistant_text: currentLocale.startsWith("es")
            ? "Perfecto, te enviaré los detalles por SMS a este número."
            : currentLocale.startsWith("pt")
              ? "Perfeito, vou enviar os detalhes por SMS para este número."
              : "Perfect, I will send the booking details by SMS to this number.",
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

        await upsertVoiceCallState({
          callSid,
          tenantId: tenant.id,
          lang: nextState.lang ?? currentLocale,
          turn: nextState.turn ?? 0,
          awaiting: false,
          pendingType: null,
          awaitingNumber: false,
          altDest: smsDestination,
          smsSent: false,
          bookingStepIndex: null,
          bookingData: postBookingStateData,
        });

        return {
          kind: "success",
          state: nextState,
          prompt: currentLocale.startsWith("es")
            ? "Perfecto, te enviaré los detalles por SMS a este número."
            : currentLocale.startsWith("pt")
              ? "Perfeito, vou enviar os detalhes por SMS para este número."
              : "Perfect, I will send the booking details by SMS to this number.",
          context: "booking_success",
        };
      }

      const postBookingStateData = {
        ...(state.bookingData || {}),
        booking_sms_payload: preservedBookingSmsPayload,
        __last_voice_domain: "booking",
        __last_booking_outcome: "confirmed",
        __last_assistant_text: currentLocale.startsWith("es")
          ? "Cliente aceptó recibir los detalles por SMS."
          : currentLocale.startsWith("pt")
            ? "O cliente aceitou receber os detalhes por SMS."
            : "Customer accepted receiving the booking details by SMS.",
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

      await upsertVoiceCallState({
        callSid,
        tenantId: tenant.id,
        lang: nextState.lang ?? currentLocale,
        turn: nextState.turn ?? 0,
        awaiting: true,
        pendingType: "reservar",
        awaitingNumber: true,
        altDest: nextState.altDest ?? null,
        smsSent: false,
        bookingStepIndex: null,
        bookingData: postBookingStateData,
      });

      return {
        kind: "awaiting_sms_destination",
        state: nextState,
      };
    }

    if (confirmationMetaSignal.intent === "reject") {
      const cancelMessageTemplate =
        typeof currentStep.validation_config?.cancel_message === "string"
          ? currentStep.validation_config.cancel_message.trim()
          : "";

      const cancelMessageResolved = resolveBookingFlowSpeech({
        baseText: cancelMessageTemplate,
        locale: currentLocale,
        bookingData: state.bookingData || {},
        callerE164,
      });

      const spokenPrompt = twoSentencesMax(
        assertNonEmptyBookingSpeech({
          text: cancelMessageResolved,
          stepKey: currentStep.step_key,
          field: "prompt",
        })
      );

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

      await upsertVoiceCallState({
        callSid,
        tenantId: tenant.id,
        lang: nextState.lang ?? currentLocale,
        turn: nextState.turn ?? 0,
        awaiting: false,
        pendingType: null,
        awaitingNumber: false,
        altDest: nextState.altDest ?? null,
        smsSent: false,
        bookingStepIndex: null,
        bookingData: postBookingStateData,
      });

      return {
        kind: "cancelled",
        state: nextState,
        prompt: spokenPrompt,
        context: "booking_offer_sms_reject",
      };
    }

    const smsRetryText = resolveBookingRetryText({
      locale: currentLocale,
      retryPrompt: currentStep.retry_prompt || "",
      retryPromptTranslations: currentStep.retry_prompt_translations || null,
      fallbackPrompt: currentStep.prompt || "",
      fallbackPromptTranslations: currentStep.prompt_translations || null,
    });

    const retry = twoSentencesMax(
      resolveBookingFlowSpeech({
        baseText: smsRetryText,
        locale: currentLocale,
        bookingData: state.bookingData || {},
        callerE164,
      })
    );

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
    let bookingTimeZone = "America/New_York";

    try {
      const { rows: settingsRows } = await pool.query(
        `
        SELECT
          default_duration_min,
          buffer_min,
          min_lead_minutes,
          timezone,
          enabled
        FROM appointment_settings
        WHERE tenant_id = $1
        LIMIT 1
        `,
        [tenant.id]
      );

      const appointmentSettings = settingsRows[0] || {
        default_duration_min: 30,
        buffer_min: 10,
        min_lead_minutes: 60,
        timezone: "America/New_York",
        enabled: true,
      };

      bookingTimeZone =
        String(appointmentSettings?.timezone || "").trim() || bookingTimeZone;

      const rawBookingData = state.bookingData || {};

      const answersBySlotBase = buildAnswersBySlot({
        flow,
        bookingData: rawBookingData,
      });

      const answersBySlot: Record<string, string | null | undefined> = {
        ...answersBySlotBase,
      };

      if (
        typeof rawBookingData.datetime_iso === "string" &&
        rawBookingData.datetime_iso.trim()
      ) {
        answersBySlot.datetime_iso = rawBookingData.datetime_iso.trim();
      }

      if (
        typeof rawBookingData.datetime_display === "string" &&
        rawBookingData.datetime_display.trim()
      ) {
        answersBySlot.datetime_display = rawBookingData.datetime_display.trim();
      }

      const appointment = await createAppointmentFromVoice({
        tenantId: tenant.id,
        answersBySlot,
        idempotencyKey: `voice:${callSid}`,
        settings: appointmentSettings,
      });

      const appointmentRecord = appointment as any;

      const successStep = resolveBookingSuccessStep({ flow });
      if (!successStep) {
        throw new Error("BOOKING_SUCCESS_STEP_NOT_CONFIGURED");
      }

      const successStepIndex = flow.findIndex(
        (step) => step.step_key === successStep.step_key
      );

      if (successStepIndex === -1) {
        throw new Error("BOOKING_SUCCESS_STEP_INDEX_NOT_FOUND");
      }

      const extraFields = buildExtraBookingFields(state.bookingData || {});

      const bookingSmsPayload = {
        business_name: String(tenant?.name || "").trim(),
        business_phone: String(
          cfg?.representante_number ||
            tenant?.twilio_voice_number ||
            tenant?.twilio_sms_number ||
            ""
        ).trim(),
        service: String(
          state.bookingData?.service_display || state.bookingData?.service || ""
        ).trim(),
        datetime: String(
          state.bookingData?.datetime_display ||
            state.bookingData?.datetime ||
            ""
        ).trim(),
        customer_name: String(
          state.bookingData?.customer_name || state.bookingData?.name || ""
        ).trim(),
        google_calendar_link: String(
          appointmentRecord?.google_event_link ||
            appointmentRecord?.googleEventLink ||
            appointmentRecord?.html_link ||
            appointmentRecord?.htmlLink ||
            appointmentRecord?.google_event_url ||
            appointmentRecord?.event_link ||
            ""
        ).trim(),
        extra_fields: extraFields,
      };

      const bookingSmsPayloadJson = JSON.stringify(bookingSmsPayload);

      const bookingSpeechData: Record<string, string> = {
        ...(state.bookingData || {}),
        service:
          state.bookingData?.service_display || state.bookingData?.service || "",
        datetime:
          state.bookingData?.datetime_display ||
          state.bookingData?.datetime ||
          "",
        datetime_display:
          state.bookingData?.datetime_display ||
          state.bookingData?.datetime ||
          "",
        datetime_iso:
          typeof state.bookingData?.datetime_iso === "string"
            ? state.bookingData.datetime_iso
            : "",
      };

      const successPromptText = resolveBookingPromptText({
        locale: currentLocale,
        prompt: successStep.prompt || "",
        promptTranslations: successStep.prompt_translations || null,
      });

      const successPromptResolved = resolveBookingFlowSpeech({
        baseText: successPromptText,
        locale: currentLocale,
        bookingData: bookingSpeechData,
        callerE164,
      });

      const successPrompt = twoSentencesMax(
        assertNonEmptyBookingSpeech({
          text: successPromptResolved,
          stepKey: successStep.step_key,
          field: "prompt",
        })
      );

      const nextStepAfterSuccess = flow[successStepIndex + 1];

      if (
        nextStepAfterSuccess &&
        nextStepAfterSuccess.step_key === "offer_booking_sms"
      ) {
        const nextPromptText = resolveBookingPromptText({
          locale: currentLocale,
          prompt: nextStepAfterSuccess.prompt || "",
          promptTranslations:
            nextStepAfterSuccess.prompt_translations || null,
        });

        const nextPromptResolved = resolveBookingFlowSpeech({
          baseText: nextPromptText,
          locale: currentLocale,
          bookingData: bookingSpeechData,
          callerE164,
        });

        const smsOfferPrompt = twoSentencesMax(
          assertNonEmptyBookingSpeech({
            text: nextPromptResolved,
            stepKey: nextStepAfterSuccess.step_key,
            field: "prompt",
          })
        );

        const nextState: CallState = {
          ...state,
          awaiting: false,
          pendingType: null,
          awaitingNumber: false,
          smsSent: false,
          bookingStepIndex: successStepIndex + 1,
          bookingData: {
            ...bookingSpeechData,
            booking_sms_payload: bookingSmsPayloadJson,
          },
        };

        await upsertVoiceCallState({
          callSid,
          tenantId: tenant.id,
          lang: nextState.lang ?? currentLocale,
          turn: nextState.turn ?? 0,
          awaiting: false,
          pendingType: null,
          awaitingNumber: false,
          altDest: nextState.altDest ?? null,
          smsSent: false,
          bookingStepIndex: successStepIndex + 1,
          bookingData: {
            ...bookingSpeechData,
            booking_sms_payload: bookingSmsPayloadJson,
          },
        });

        return {
          kind: "success_offer_sms",
          state: nextState,
          successPrompt,
          smsOfferPrompt,
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
          ...bookingSpeechData,
          booking_sms_payload: bookingSmsPayloadJson,
          __last_voice_domain: "booking",
          __last_booking_outcome: "confirmed",
          __last_assistant_text: successPrompt,
        },
      };

      await upsertVoiceCallState({
        callSid,
        tenantId: tenant.id,
        lang: nextState.lang ?? currentLocale,
        turn: nextState.turn ?? 0,
        awaiting: false,
        pendingType: null,
        awaitingNumber: false,
        altDest: nextState.altDest ?? null,
        smsSent: false,
        bookingStepIndex: null,
        bookingData: nextState.bookingData || {},
      });

      return {
        kind: "success",
        state: nextState,
        prompt: successPrompt,
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
            timeZone: bookingTimeZone,
            suggestedStarts,
          },
        };
      }

      const failRaw =
        typeof cfg?.booking_error_message === "string" &&
        cfg.booking_error_message.trim()
          ? cfg.booking_error_message.trim()
          : currentLocale.startsWith("es")
            ? "No pude completar la reserva en este momento. ¿Quieres que te ayude con otra cosa?"
            : currentLocale.startsWith("pt")
              ? "Não consegui concluir a reserva neste momento. Posso te ajudar com mais alguma coisa?"
              : "I could not complete the booking right now. Can I help you with anything else?";

      const failPrompt = twoSentencesMax(failRaw);

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

      await upsertVoiceCallState({
        callSid,
        tenantId: tenant.id,
        lang: nextState.lang ?? currentLocale,
        turn: nextState.turn ?? 0,
        awaiting: false,
        pendingType: null,
        awaitingNumber: false,
        altDest: nextState.altDest ?? null,
        smsSent: false,
        bookingStepIndex: null,
        bookingData: postBookingStateData,
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
    const cancelMessageTemplate =
      typeof currentStep.validation_config?.cancel_message === "string"
        ? currentStep.validation_config.cancel_message.trim()
        : "";

    const cancelMessageResolved = resolveBookingFlowSpeech({
      baseText: cancelMessageTemplate,
      locale: currentLocale,
      bookingData: state.bookingData || {},
      callerE164,
    });

    const cancelPrompt = twoSentencesMax(
      assertNonEmptyBookingSpeech({
        text: cancelMessageResolved,
        stepKey: currentStep.step_key,
        field: "prompt",
      })
    );

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

    await upsertVoiceCallState({
      callSid,
      tenantId: tenant.id,
      lang: nextState.lang ?? currentLocale,
      turn: nextState.turn ?? 0,
      awaiting: false,
      pendingType: null,
      awaitingNumber: false,
      altDest: nextState.altDest ?? null,
      smsSent: false,
      bookingStepIndex: null,
      bookingData: postBookingStateData,
    });

    return {
      kind: "cancelled",
      state: nextState,
      prompt: spokenPrompt,
      context: "booking_cancel_followup",
    };
  }

  const confirmationRetryText = resolveBookingRetryText({
    locale: currentLocale,
    retryPrompt: currentStep.retry_prompt || "",
    retryPromptTranslations: currentStep.retry_prompt_translations || null,
    fallbackPrompt: currentStep.prompt || "",
    fallbackPromptTranslations: currentStep.prompt_translations || null,
  });

  const retry = twoSentencesMax(
    resolveBookingFlowSpeech({
      baseText: confirmationRetryText,
      locale: currentLocale,
      bookingData: state.bookingData || {},
      callerE164,
    })
  );

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