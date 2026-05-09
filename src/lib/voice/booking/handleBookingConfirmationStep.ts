//src/lib/voice/booking/handleBookingConfirmationStep.ts
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

export async function handleBookingConfirmationStep(
  params: HandleBookingConfirmationStepParams
): Promise<BookingStepHandlerResult> {
  const {
    vr,
    tenant,
    cfg,
    flow,
    currentStep,
    currentLocale,
    voiceName,
    callSid,
    didNumber,
    callerE164,
    userInput,
    digits,
    state,
    createBookingGather,
    logBotSay,
    upsertVoiceCallState,
  } = params;

  const confirmationMetaSignal =
    digits === "1"
      ? { intent: "affirm" as const, confidence: 1 }
      : digits === "2"
      ? { intent: "reject" as const, confidence: 1 }
      : await resolveVoiceMetaSignal({
          utterance: userInput,
          locale: currentLocale,
        });

  const rawSlot =
    typeof currentStep.validation_config?.slot === "string"
      ? currentStep.validation_config.slot.trim()
      : "";

  const isBookingConfirmationStep =
    rawSlot === "confirmation" || currentStep.step_key === "confirm";

  const isOfferBookingSmsStep = currentStep.step_key === "offer_booking_sms";

  if (isOfferBookingSmsStep) {
    if (confirmationMetaSignal.intent === "affirm" || digits === "1") {
      const preservedBookingSmsPayload =
        typeof state.bookingData?.booking_sms_payload === "string"
          ? state.bookingData.booking_sms_payload
          : "";

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
        awaiting: true,
        pendingType: "reservar",
        awaitingNumber: false,
        altDest: nextState.altDest ?? null,
        smsSent: false,
        bookingStepIndex: null,
        bookingData: postBookingStateData,
      });

      console.log("[VOICE][BOOKING_SMS][PAYLOAD_PRESERVED_AFTER_ACCEPT]", {
        callSid,
        tenantId: tenant.id,
        hasPayload: Boolean(postBookingStateData.booking_sms_payload),
        bookingSmsPayload: postBookingStateData.booking_sms_payload || null,
      });

      return {
        handled: false,
        state: nextState,
      };
    }

    if (confirmationMetaSignal.intent === "reject" || digits === "2") {
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

      const gather = createBookingGather({
        vr,
        locale: currentLocale,
        isConfirmationStep: true,
      });

      gather.say(
        { language: currentLocale as any, voice: voiceName },
        spokenPrompt
      );

      logBotSay({
        callSid,
        to: didNumber || "ivr",
        text: spokenPrompt,
        lang: currentLocale,
        context: "booking_offer_sms_reject",
      });

      return {
        handled: true,
        state: nextState,
        twiml: vr.toString(),
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

    const gather = createBookingGather({
      vr,
      locale: currentLocale,
      isConfirmationStep: true,
    });

    gather.say({ language: currentLocale as any, voice: voiceName }, retry);

    return {
      handled: true,
      state,
      twiml: vr.toString(),
    };
  }

  if (!isBookingConfirmationStep) {
    return { handled: false, state };
  }

  if (confirmationMetaSignal.intent === "affirm" || digits === "1") {
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

      console.log("[VOICE][BOOKING][ANSWERS_BY_SLOT]", {
        callSid,
        answersBySlot,
        bookingData: rawBookingData,
      });

      console.log("[VOICE][BOOKING][ANSWERS_BY_SLOT]", {
        callSid,
        answersBySlot,
        bookingData: state.bookingData || {},
      });

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

        const gather = createBookingGather({
          vr,
          locale: currentLocale,
          isConfirmationStep: true,
        });

        gather.say(
          { language: currentLocale as any, voice: voiceName },
          successPrompt
        );

        gather.say(
          { language: currentLocale as any, voice: voiceName },
          smsOfferPrompt
        );

        logBotSay({
          callSid,
          to: didNumber || "ivr",
          text: `${successPrompt} ${smsOfferPrompt}`,
          lang: currentLocale,
          context: "booking_success_offer_sms",
        });

        return {
          handled: true,
          state: nextState,
          twiml: vr.toString(),
        };
      }

      const gather = createBookingGather({
        vr,
        locale: currentLocale,
        isConfirmationStep: true,
      });

      gather.say(
        { language: currentLocale as any, voice: voiceName },
        successPrompt
      );

      logBotSay({
        callSid,
        to: didNumber || "ivr",
        text: successPrompt,
        lang: currentLocale,
        context: "booking_success",
      });

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
        handled: true,
        state: nextState,
        twiml: vr.toString(),
      };
    } catch (err: any) {
      console.error("❌ Error creando cita:", err);

      const providerError =
        err?.error || err?.code || err?.providerError || null;

      const suggestedStarts: string[] = Array.isArray(err?.suggestedStarts)
        ? err.suggestedStarts
        : [];

      if (providerError === "SLOT_BUSY") {
        const recovered = await handleBookingSlotBusyRecovery({
          vr,
          flow,
          state,
          tenantId: tenant.id,
          callSid,
          currentLocale,
          voiceName,
          didNumber,
          callerE164,
          timeZone: bookingTimeZone,
          suggestedStarts,
          logBotSay,
        });

        return {
          handled: true,
          state: recovered.state,
          twiml: recovered.twiml,
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

      const gather = createBookingGather({
        vr,
        locale: currentLocale,
        isConfirmationStep: true,
      });

      gather.say(
        { language: currentLocale as any, voice: voiceName },
        failPrompt
      );

      logBotSay({
        callSid,
        to: didNumber || "ivr",
        text: failPrompt,
        lang: currentLocale,
        context: "booking_create_failed_keep_call_alive",
      });

      return {
        handled: true,
        state: nextState,
        twiml: vr.toString(),
      };
    }
  }

  if (confirmationMetaSignal.intent === "reject" || digits === "2") {
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

    const gather = createBookingGather({
      vr,
      locale: currentLocale,
      isConfirmationStep: true,
    });

    gather.say(
      { language: currentLocale as any, voice: voiceName },
      spokenPrompt
    );

    logBotSay({
      callSid,
      to: didNumber || "ivr",
      text: spokenPrompt,
      lang: currentLocale,
      context: "booking_cancel_followup",
    });

    return {
      handled: true,
      state: nextState,
      twiml: vr.toString(),
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

  const gather = createBookingGather({
    vr,
    locale: currentLocale,
    isConfirmationStep: true,
  });

  gather.say({ language: currentLocale as any, voice: voiceName }, retry);

  return {
    handled: true,
    state,
    twiml: vr.toString(),
  };
}