//src/lib/voice/handleVoiceBookingTurn.ts
import { twiml } from "twilio";
import pool from "../db";
import { getBookingFlow } from "../appointments/getBookingFlow";
import { createAppointmentFromVoice } from "../appointments/createAppointmentFromVoice";
import { resolveVoiceScheduleValidation } from "../appointments/resolveVoiceScheduleValidation";
import { upsertVoiceCallState } from "./upsertVoiceCallState";
import { deleteVoiceCallState } from "./deleteVoiceCallState";
import { resolveVoiceIntentFromUtteranceAsync } from "./resolveVoiceIntentFromUtterance";
import { CallState, VoiceLocale } from "./types";
import {
  buildAnswersBySlot,
  resolveBookingFlowSpeech,
  resolveBookingPromptText,
  resolveBookingRetryText,
  resolveBookingSuccessStep,
  resolvePhoneFromVoiceInput,
  resolveVoiceBookingService,
} from "./voiceBookingHelpers";
import { resolveVoiceMetaSignal } from "./resolveVoiceMetaSignal";
import { twoSentencesMax } from "./speechFormatting";

function buildExtraBookingFields(
  bookingData: Record<string, any> | undefined
): Record<string, string> {
  const excludedKeys = new Set([
    "service",
    "service_display",
    "datetime",
    "datetime_display",
    "customer_name",
    "name",
    "customer_phone",
    "phone",
    "customer_email",
    "email",
    "confirmation",
    "booking_sms_payload",
    "__voice_intro_played",
    "__last_voice_domain",
    "__last_booking_outcome",
    "__last_assistant_text",
    "__last_booking_error",
  ]);

  return Object.fromEntries(
    Object.entries(bookingData || {})
      .filter(([key, value]) => {
        const cleanKey = String(key || "").trim();
        const cleanValue = String(value || "").trim();

        return cleanKey && cleanValue && !excludedKeys.has(cleanKey);
      })
      .map(([key, value]) => [key, String(value).trim()])
  );
}

function formatSuggestedStartForVoice(
  dateISO: string,
  locale: VoiceLocale,
  timeZone: string
) {
  const date = new Date(dateISO);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  if (locale.startsWith("es")) {
    return new Intl.DateTimeFormat("es-US", {
      weekday: "long",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone,
    }).format(date);
  }

  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
  }).format(date);
}

function buildBusyAlternativesPrompt(params: {
  locale: VoiceLocale;
  suggestedStarts: string[];
  timeZone: string;
  fallbackText: string;
}) {
  const formatted = params.suggestedStarts
    .map((iso) =>
      formatSuggestedStartForVoice(iso, params.locale, params.timeZone)
    )
    .filter(Boolean)
    .slice(0, 3);

  const optionsText = formatted.join(", ");

  return params.fallbackText
    .replace(/\{available_times\}/g, optionsText)
    .replace(/\{suggested_times\}/g, optionsText)
    .trim();
}

function assertNonEmptyBookingSpeech(input: {
  text: string;
  stepKey: string;
  field: "prompt" | "retry_prompt" | "unavailable_prompt";
}) {
  const value = (input.text || "").trim();

  if (!value) {
    throw new Error(
      `BOOKING_FLOW_EMPTY_SPEECH:${input.stepKey}:${input.field}`
    );
  }

  return value;
}

function resolveBookingSpeechFast(params: {
  baseText: string;
  locale: VoiceLocale;
  bookingData?: Record<string, any>;
  callerE164?: string | null;
}) {
  const hasTemplateVars = /\{[^}]+\}/.test(params.baseText || "");
  const hasCallerPlaceholder = (params.baseText || "").includes("{caller_phone}");

  if (!hasTemplateVars && !hasCallerPlaceholder) {
    return params.baseText.trim();
  }

  return null;
}

function createBookingGather(params: {
  vr: twiml.VoiceResponse;
  locale: VoiceLocale;
  isPhoneStep?: boolean;
  isConfirmationStep?: boolean;
}) {
  const input =
    params.isPhoneStep || params.isConfirmationStep
      ? (["speech", "dtmf"] as any)
      : (["speech"] as any);

  return params.vr.gather({
    input,
    numDigits: params.isPhoneStep ? 15 : params.isConfirmationStep ? 1 : undefined,
    action: "/webhook/voice-response",
    method: "POST",
    language: params.locale as any,
    speechTimeout: "1",
    timeout: 5,
    actionOnEmptyResult: true,
    bargeIn: true,
  });
}

type CachedBookingFlow = Awaited<ReturnType<typeof getBookingFlow>>;

type BookingFlowCacheEntry = {
  expiresAt: number;
  flow: CachedBookingFlow;
};

const BOOKING_FLOW_TTL_MS = 60_000;
const bookingFlowCache = new Map<string, BookingFlowCacheEntry>();

export function clearVoiceBookingFlowCache(tenantId?: string) {
  if (!tenantId) {
    bookingFlowCache.clear();
    return;
  }

  bookingFlowCache.delete(tenantId);
}

async function getCachedBookingFlow(tenantId: string): Promise<CachedBookingFlow> {
  const now = Date.now();
  const cached = bookingFlowCache.get(tenantId);

  if (cached && cached.expiresAt > now) {
    return cached.flow;
  }

  const flow = await getBookingFlow(tenantId);

  bookingFlowCache.set(tenantId, {
    expiresAt: now + BOOKING_FLOW_TTL_MS,
    flow,
  });

  return flow;
}

type HandleVoiceBookingTurnParams = {
  vr: twiml.VoiceResponse;
  tenant: any;
  cfg: any;
  callSid: string;
  didNumber: string;
  callerE164: string | null;
  currentLocale: VoiceLocale;
  voiceName: any;
  state: CallState;
  userInput: string;
  effectiveUserInput: string;
  digits: string;
  logBotSay: (input: {
    callSid: string;
    to: string;
    text: string;
    lang?: string;
    context?: string;
  }) => void;
};

type HandleVoiceBookingTurnResult =
  | { handled: false; state: CallState }
  | { handled: true; state: CallState; twiml: string };

export async function handleVoiceBookingTurn(
  params: HandleVoiceBookingTurnParams
): Promise<HandleVoiceBookingTurnResult> {
  const {
    vr,
    tenant,
    cfg,
    callSid,
    didNumber,
    callerE164,
    currentLocale,
    voiceName,
    logBotSay,
    userInput,
    effectiveUserInput,
    digits,
  } = params;

  let state = params.state;

  if (!effectiveUserInput && typeof state.bookingStepIndex !== "number") {
    return { handled: false, state };
  }

  const bookingAlreadyActive = typeof state.bookingStepIndex === "number";

  if (!bookingAlreadyActive && !effectiveUserInput) {
    return { handled: false, state };
  }

  const resolvedIntent = bookingAlreadyActive
    ? "booking"
    : effectiveUserInput
      ? await resolveVoiceIntentFromUtteranceAsync(effectiveUserInput, {
          timeoutMs: 1500,
          minConfidence: 0.65,
        })
      : null;

  const wantsBooking =
    bookingAlreadyActive ||
    resolvedIntent === "booking";

  if (!wantsBooking) {
    return { handled: false, state };
  }

  const flow = await getCachedBookingFlow(tenant.id);

  if (!flow.length) {
    throw new Error("BOOKING_FLOW_NOT_CONFIGURED");
  }

  if (typeof state.bookingStepIndex !== "number") {
    const firstStep = flow[0];

    const preservedBookingData: Record<string, any> = {};

    if (state.bookingData?.__voice_intro_played) {
      preservedBookingData.__voice_intro_played =
        state.bookingData.__voice_intro_played;
    }

    state = {
      ...state,
      awaiting: false,
      pendingType: null,
      awaitingNumber: false,
      smsSent: false,
      bookingStepIndex: 0,
      bookingData: preservedBookingData,
    };

    await upsertVoiceCallState({
      callSid,
      tenantId: tenant.id,
      lang: state.lang ?? currentLocale,
      turn: state.turn ?? 0,
      awaiting: false,
      pendingType: null,
      awaitingNumber: false,
      altDest: state.altDest ?? null,
      smsSent: false,
      bookingStepIndex: 0,
      bookingData: preservedBookingData,
    });

    const firstStepPromptText = resolveBookingPromptText({
      locale: currentLocale,
      prompt: firstStep.prompt || "",
      promptTranslations: firstStep.prompt_translations || null,
    });

    const askResolved =
      resolveBookingSpeechFast({
        baseText: firstStepPromptText,
        locale: currentLocale,
        bookingData: state.bookingData || {},
        callerE164,
      }) ||
      (resolveBookingFlowSpeech({
        baseText: firstStepPromptText,
        locale: currentLocale,
        bookingData: state.bookingData || {},
        callerE164,
      }));

    const ask = twoSentencesMax(
      assertNonEmptyBookingSpeech({
        text: askResolved,
        stepKey: firstStep.step_key,
        field: "prompt",
      })
    );

    const gather = createBookingGather({
      vr,
      locale: currentLocale,
    });

    gather.say({ language: currentLocale as any, voice: voiceName }, ask);

    logBotSay({
      callSid,
      to: didNumber || "ivr",
      text: ask,
      lang: currentLocale,
      context: "booking_start",
    });

    return {
      handled: true,
      state,
      twiml: vr.toString(),
    };
  }

  const currentIndex = state.bookingStepIndex;
  const currentStep = flow[currentIndex];

  if (!currentStep) {
    await deleteVoiceCallState(callSid);
    throw new Error("BOOKING_STEP_NOT_FOUND");
  }

  if (!effectiveUserInput && !digits) {
    const retryText = resolveBookingRetryText({
      locale: currentLocale,
      retryPrompt: currentStep.retry_prompt || "",
      retryPromptTranslations: currentStep.retry_prompt_translations || null,
      fallbackPrompt: currentStep.prompt || "",
      fallbackPromptTranslations: currentStep.prompt_translations || null,
    });

    const retryPromptResolved = resolveBookingFlowSpeech({
      baseText: retryText,
      locale: currentLocale,
      bookingData: state.bookingData || {},
      callerE164,
    });

    const prompt = twoSentencesMax(
      assertNonEmptyBookingSpeech({
        text: retryPromptResolved,
        stepKey: currentStep.step_key,
        field: currentStep.retry_prompt ? "retry_prompt" : "prompt",
      })
    );

    const gather = createBookingGather({
      vr,
      locale: currentLocale,
      isPhoneStep: currentStep.expected_type === "phone",
      isConfirmationStep: currentStep.expected_type === "confirmation",
    });

    gather.say(
      { language: currentLocale as any, voice: voiceName },
      prompt
    );

    logBotSay({
      callSid,
      to: didNumber || "ivr",
      text: prompt,
      lang: currentLocale,
      context: `booking_empty_input_retry:${currentStep.step_key}`,
    });

    return {
      handled: true,
      state,
      twiml: vr.toString(),
    };
  }

  if (currentStep.expected_type === "confirmation") {
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

    const isOfferBookingSmsStep =
      currentStep.step_key === "offer_booking_sms";

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
          __last_assistant_text:
            currentLocale.startsWith("es")
              ? "Cliente aceptó recibir los detalles por SMS."
              : currentLocale.startsWith("pt")
              ? "O cliente aceitou receber os detalhes por SMS."
              : "Customer accepted receiving the booking details by SMS.",
        };

        state = {
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
          lang: state.lang ?? currentLocale,
          turn: state.turn ?? 0,
          awaiting: true,
          pendingType: "reservar",
          awaitingNumber: false,
          altDest: state.altDest ?? null,
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
          state,
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

        state = {
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
          lang: state.lang ?? currentLocale,
          turn: state.turn ?? 0,
          awaiting: false,
          pendingType: null,
          awaitingNumber: false,
          altDest: state.altDest ?? null,
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
          state,
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

        const answersBySlot = buildAnswersBySlot({
          flow,
          bookingData: state.bookingData || {},
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
            state.bookingData?.service_display ||
            state.bookingData?.service ||
            ""
          ).trim(),
          datetime: String(
            state.bookingData?.datetime_display ||
            state.bookingData?.datetime ||
            ""
          ).trim(),
          customer_name: String(
            state.bookingData?.customer_name ||
            state.bookingData?.name ||
            ""
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
            state.bookingData?.service_display ||
            state.bookingData?.service ||
            "",
          datetime:
            state.bookingData?.datetime_display ||
            state.bookingData?.datetime ||
            "",
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
            promptTranslations: nextStepAfterSuccess.prompt_translations || null,
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

          state = {
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
            lang: state.lang ?? currentLocale,
            turn: state.turn ?? 0,
            awaiting: false,
            pendingType: null,
            awaitingNumber: false,
            altDest: state.altDest ?? null,
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
            state,
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

        state = {
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
          lang: state.lang ?? currentLocale,
          turn: state.turn ?? 0,
          awaiting: false,
          pendingType: null,
          awaitingNumber: false,
          altDest: state.altDest ?? null,
          smsSent: false,
          bookingStepIndex: null,
          bookingData: state.bookingData,
        });

        return {
          handled: true,
          state,
          twiml: vr.toString(),
        };
      } catch (err: any) {
        console.error("❌ Error creando cita:", err);

        const providerError =
          err?.error ||
          err?.code ||
          err?.providerError ||
          null;

        const suggestedStarts: string[] = Array.isArray(err?.suggestedStarts)
          ? err.suggestedStarts
          : [];

        if (providerError === "SLOT_BUSY") {
          const confirmationRetryText = resolveBookingRetryText({
            locale: currentLocale,
            retryPrompt: currentStep.retry_prompt || "",
            retryPromptTranslations: currentStep.retry_prompt_translations || null,
            fallbackPrompt: currentStep.prompt || "",
            fallbackPromptTranslations: currentStep.prompt_translations || null,
          });

          const busyPrompt = buildBusyAlternativesPrompt({
            locale: currentLocale,
            suggestedStarts,
            timeZone: bookingTimeZone,
            fallbackText: confirmationRetryText,
          });

          const gather = createBookingGather({
            vr,
            locale: currentLocale,
          });

          gather.say(
            { language: currentLocale as any, voice: voiceName },
            twoSentencesMax(busyPrompt)
          );

          logBotSay({
            callSid,
            to: didNumber || "ivr",
            text: busyPrompt,
            lang: currentLocale,
            context: "booking_busy_alternatives",
          });

          return {
            handled: true,
            state,
            twiml: vr.toString(),
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

        state = {
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
          lang: state.lang ?? currentLocale,
          turn: state.turn ?? 0,
          awaiting: false,
          pendingType: null,
          awaitingNumber: false,
          altDest: state.altDest ?? null,
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
          state,
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

      state = {
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
        lang: state.lang ?? currentLocale,
        turn: state.turn ?? 0,
        awaiting: false,
        pendingType: null,
        awaitingNumber: false,
        altDest: state.altDest ?? null,
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
        state,
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

  if (currentStep.expected_type === "phone") {
    const phoneResolution = resolvePhoneFromVoiceInput({
      userInput: effectiveUserInput,
      digits,
      callerE164,
      step: currentStep,
    });

    if (!phoneResolution.ok) {
      const gather = createBookingGather({
        vr,
        locale: currentLocale,
        isPhoneStep: true,
      });

      const phoneRetryText = resolveBookingRetryText({
        locale: currentLocale,
        retryPrompt: currentStep.retry_prompt || "",
        retryPromptTranslations: currentStep.retry_prompt_translations || null,
        fallbackPrompt: currentStep.prompt || "",
        fallbackPromptTranslations: currentStep.prompt_translations || null,
      });

      const retryPromptResolved = resolveBookingFlowSpeech({
        baseText: phoneRetryText,
        locale: currentLocale,
        bookingData: state.bookingData || {},
        callerE164,
      });

      const retryPrompt = twoSentencesMax(
        assertNonEmptyBookingSpeech({
          text: retryPromptResolved,
          stepKey: currentStep.step_key,
          field: currentStep.retry_prompt ? "retry_prompt" : "prompt",
        })
      );

      gather.say(
        { language: currentLocale as any, voice: voiceName },
        retryPrompt
      );

      return {
        handled: true,
        state,
        twiml: vr.toString(),
      };
    }

    const nextData: Record<string, string> = {
      ...(state.bookingData || {}),
      [currentStep.step_key]: phoneResolution.value,
    };

    const nextIndex = currentIndex + 1;
    const nextStep = flow[nextIndex];

    if (!nextStep) {
      await deleteVoiceCallState(callSid);
      throw new Error("BOOKING_CONFIRM_STEP_MISSING");
    }

    const nextStepPromptTextAfterPhone = resolveBookingPromptText({
      locale: currentLocale,
      prompt: nextStep.prompt || "",
      promptTranslations: nextStep.prompt_translations || null,
    });

    const prompt = twoSentencesMax(
      resolveBookingFlowSpeech({
        baseText: nextStepPromptTextAfterPhone,
        locale: currentLocale,
        bookingData: nextData,
        callerE164,
      })
    );

    state = {
      ...state,
      bookingStepIndex: nextIndex,
      bookingData: nextData,
    };

    await upsertVoiceCallState({
      callSid,
      tenantId: tenant.id,
      lang: state.lang ?? currentLocale,
      turn: state.turn ?? 0,
      awaiting: state.awaiting ?? false,
      pendingType: state.pendingType ?? null,
      awaitingNumber: state.awaitingNumber ?? false,
      altDest: state.altDest ?? null,
      smsSent: state.smsSent ?? false,
      bookingStepIndex: nextIndex,
      bookingData: nextData,
    });

    const isPhoneStep = nextStep.expected_type === "phone";
    const isConfirmationStep = nextStep.expected_type === "confirmation";

    const gather = createBookingGather({
      vr,
      locale: currentLocale,
      isPhoneStep,
      isConfirmationStep,
    });

    gather.say(
      { language: currentLocale as any, voice: voiceName },
      prompt
    );

    return {
      handled: true,
      state,
      twiml: vr.toString(),
    };
  }

  let resolvedStepValue = effectiveUserInput;

  const rawSlot =
    typeof currentStep.validation_config?.slot === "string"
      ? currentStep.validation_config.slot.trim()
      : "";

  const isServiceStep =
    currentStep.step_key === "service" || rawSlot === "service";

  if (isServiceStep) {
    const serviceResolution = resolveVoiceBookingService({
      userInput: effectiveUserInput,
      rawConfig: cfg?.booking_services_text || "",
    });

    if (serviceResolution.kind === "none") {
      const serviceRetryText = resolveBookingRetryText({
        locale: currentLocale,
        retryPrompt: currentStep.retry_prompt || "",
        retryPromptTranslations: currentStep.retry_prompt_translations || null,
        fallbackPrompt: currentStep.prompt || "",
        fallbackPromptTranslations: currentStep.prompt_translations || null,
      });

      const retryPromptResolved = resolveBookingFlowSpeech({
        baseText: serviceRetryText,
        locale: currentLocale,
        bookingData: state.bookingData || {},
        callerE164,
      });

      const retryPrompt = twoSentencesMax(
        assertNonEmptyBookingSpeech({
          text: retryPromptResolved,
          stepKey: currentStep.step_key,
          field: currentStep.retry_prompt ? "retry_prompt" : "prompt",
        })
      );

      const gather = createBookingGather({
        vr,
        locale: currentLocale,
      });

      gather.say(
        { language: currentLocale as any, voice: voiceName },
        retryPrompt
      );

      return {
        handled: true,
        state,
        twiml: vr.toString(),
      };
    }

    if (serviceResolution.kind === "ambiguous") {
      const optionsText = serviceResolution.options.join(", ");

      const ambiguousBaseText = resolveBookingRetryText({
        locale: currentLocale,
        retryPrompt: currentStep.retry_prompt || "",
        retryPromptTranslations: currentStep.retry_prompt_translations || null,
        fallbackPrompt: currentStep.prompt || "",
        fallbackPromptTranslations: currentStep.prompt_translations || null,
      });

      const ambiguousPrompt = resolveBookingFlowSpeech({
        baseText: ambiguousBaseText,
        locale: currentLocale,
        bookingData: {
          ...(state.bookingData || {}),
          optionsText,
          available_options: optionsText,
        },
        callerE164,
      });

      const gather = createBookingGather({
        vr,
        locale: currentLocale,
      });

      gather.say(
        { language: currentLocale as any, voice: voiceName },
        twoSentencesMax(ambiguousPrompt)
      );

      return {
        handled: true,
        state,
        twiml: vr.toString(),
      };
    }

    resolvedStepValue = serviceResolution.value;

    const localizedServiceDisplay = resolveBookingFlowSpeech({
      baseText: serviceResolution.value,
      locale: currentLocale,
      bookingData: state.bookingData || {},
      callerE164,
    });

    state = {
      ...state,
      bookingData: {
        ...(state.bookingData || {}),
        service_display: localizedServiceDisplay || serviceResolution.value,
      },
    };
  }

  const isDatetimeStep =
    currentStep.step_key === "datetime" || rawSlot === "datetime";

  if (isDatetimeStep) {
    const currentBookingData = {
      ...(state.bookingData || {}),
      [currentStep.step_key]: resolvedStepValue,
    };

    const serviceName = String(
      currentBookingData.service || currentBookingData["service"] || ""
    ).trim();

    const rawDatetime = String(resolvedStepValue || "").trim();

    if (!rawDatetime) {
      state = {
        ...state,
        bookingStepIndex: currentIndex,
        bookingData: currentBookingData,
      };

      await upsertVoiceCallState({
        callSid,
        tenantId: tenant.id,
        lang: state.lang ?? currentLocale,
        turn: state.turn ?? 0,
        awaiting: false,
        pendingType: null,
        awaitingNumber: false,
        altDest: state.altDest ?? null,
        smsSent: state.smsSent ?? false,
        bookingStepIndex: currentIndex,
        bookingData: currentBookingData,
      });

      const localizedRetryBase = resolveBookingRetryText({
        locale: currentLocale,
        retryPrompt: currentStep.retry_prompt || "",
        retryPromptTranslations: currentStep.retry_prompt_translations || null,
        fallbackPrompt: currentStep.prompt || "",
        fallbackPromptTranslations: currentStep.prompt_translations || null,
      });

      const retryPromptResolved = resolveBookingFlowSpeech({
        baseText: localizedRetryBase,
        locale: currentLocale,
        bookingData: {
          ...currentBookingData,
          requested_service: String(currentBookingData.service || "").trim(),
          requested_datetime: rawDatetime,
          available_times: "",
        },
        callerE164,
      });

      const retryPrompt = twoSentencesMax(
        assertNonEmptyBookingSpeech({
          text: retryPromptResolved,
          stepKey: currentStep.step_key,
          field: currentStep.retry_prompt ? "retry_prompt" : "prompt",
        })
      );

      const gather = createBookingGather({
        vr,
        locale: currentLocale,
      });

      gather.say(
        { language: currentLocale as any, voice: voiceName },
        retryPrompt
      );

      logBotSay({
        callSid,
        to: didNumber || "ivr",
        text: retryPrompt,
        lang: currentLocale,
        context: `booking_retry_empty_datetime:${currentStep.step_key}`,
      });

      return {
        handled: true,
        state,
        twiml: vr.toString(),
      };
    }

    if (serviceName && rawDatetime) {
      const scheduleValidation = await resolveVoiceScheduleValidation({
        tenantId: tenant.id,
        serviceName,
        rawDatetime,
        channel: "voice",
      });

      if (!scheduleValidation.ok) {
        state = {
          ...state,
          bookingStepIndex: currentIndex,
          bookingData: currentBookingData,
        };

        await upsertVoiceCallState({
          callSid,
          tenantId: tenant.id,
          lang: state.lang ?? currentLocale,
          turn: state.turn ?? 0,
          awaiting: false,
          pendingType: null,
          awaitingNumber: false,
          altDest: state.altDest ?? null,
          smsSent: state.smsSent ?? false,
          bookingStepIndex: currentIndex,
          bookingData: currentBookingData,
        });

        const unavailablePrompt =
          typeof currentStep.validation_config?.unavailable_prompt === "string"
            ? currentStep.validation_config.unavailable_prompt.trim()
            : "";

        const localizedRetryBase = resolveBookingRetryText({
          locale: currentLocale,
          retryPrompt: currentStep.retry_prompt || "",
          retryPromptTranslations: currentStep.retry_prompt_translations || null,
          fallbackPrompt: currentStep.prompt || "",
          fallbackPromptTranslations: currentStep.prompt_translations || null,
        });

        const promptTemplate =
          scheduleValidation.reason === "schedule_not_available" && unavailablePrompt
            ? unavailablePrompt
            : localizedRetryBase;

        const rawAvailableTimes =
          scheduleValidation.reason === "schedule_not_available"
            ? scheduleValidation.availableTimes || []
            : [];

        const availableTimesText = rawAvailableTimes.join(", ");

        const suggestedStarts =
          scheduleValidation.reason === "schedule_not_available" &&
          Array.isArray(scheduleValidation.suggestedStarts)
            ? scheduleValidation.suggestedStarts
            : [];

        const retryBaseResolved = resolveBookingFlowSpeech({
          baseText: promptTemplate,
          locale: currentLocale,
          bookingData: {
            ...currentBookingData,
            requested_service: String(currentBookingData.service || "").trim(),
            requested_datetime: rawDatetime,
            available_times: availableTimesText,
            suggested_times: availableTimesText,
          },
          callerE164,
        });

        const retryPromptResolved =
          scheduleValidation.reason === "schedule_not_available" &&
          suggestedStarts.length > 0
            ? buildBusyAlternativesPrompt({
                locale: currentLocale,
                suggestedStarts,
                timeZone:
                  String(scheduleValidation.timeZone || "").trim() || "America/New_York",
                fallbackText: retryBaseResolved,
              })
            : retryBaseResolved;

        const retryPrompt = twoSentencesMax(
          assertNonEmptyBookingSpeech({
            text: retryPromptResolved,
            stepKey: currentStep.step_key,
            field:
              scheduleValidation.reason === "schedule_not_available" && unavailablePrompt
                ? "unavailable_prompt"
                : currentStep.retry_prompt
                  ? "retry_prompt"
                  : "prompt",
          })
        );

        const gather = createBookingGather({
          vr,
          locale: currentLocale,
        });

        gather.say(
          { language: currentLocale as any, voice: voiceName },
          retryPrompt
        );

        logBotSay({
          callSid,
          to: didNumber || "ivr",
          text: retryPrompt,
          lang: currentLocale,
          context: `booking_retry:${currentStep.step_key}`,
        });

        return {
          handled: true,
          state,
          twiml: vr.toString(),
        };
      }
    }
  }

  const nextData = {
    ...(state.bookingData || {}),
    [currentStep.step_key]: resolvedStepValue,
    ...(isServiceStep
      ? {
        service_display:
          state.bookingData?.service_display || resolvedStepValue,
        }
      : {}),
    ...(isDatetimeStep
      ? {
        datetime_display: String(resolvedStepValue || "").trim(),
        }
      : {}),
  };

  const nextIndex = currentIndex + 1;
  const nextStep = flow[nextIndex];

  if (!nextStep) {
    await deleteVoiceCallState(callSid);
    throw new Error("BOOKING_CONFIRM_STEP_MISSING");
  }

  const nextStepPromptText = resolveBookingPromptText({
    locale: currentLocale,
    prompt: nextStep.prompt || "",
    promptTranslations: nextStep.prompt_translations || null,
  });

  const promptResolved = resolveBookingFlowSpeech({
    baseText: nextStepPromptText,
    locale: currentLocale,
    bookingData: nextData,
    callerE164,
  });

  const prompt = twoSentencesMax(
    assertNonEmptyBookingSpeech({
      text: promptResolved,
      stepKey: nextStep.step_key,
      field: "prompt",
    })
  );

  state = {
    ...state,
    bookingStepIndex: nextIndex,
    bookingData: nextData,
  };

  await upsertVoiceCallState({
    callSid,
    tenantId: tenant.id,
    lang: state.lang ?? currentLocale,
    turn: state.turn ?? 0,
    awaiting: state.awaiting ?? false,
    pendingType: state.pendingType ?? null,
    awaitingNumber: state.awaitingNumber ?? false,
    altDest: state.altDest ?? null,
    smsSent: state.smsSent ?? false,
    bookingStepIndex: nextIndex,
    bookingData: nextData,
  });

  const isPhoneStep = nextStep.expected_type === "phone";
  const isConfirmationStep = nextStep.expected_type === "confirmation";

  const gather = createBookingGather({
    vr,
    locale: currentLocale,
    isPhoneStep,
    isConfirmationStep,
  });

  gather.say(
    { language: currentLocale as any, voice: voiceName },
    prompt
  );

  return {
    handled: true,
    state,
    twiml: vr.toString(),
  };
}