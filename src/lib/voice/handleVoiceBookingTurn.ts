//src/lib/voice/handleVoiceBookingTurn.ts
import { twiml } from "twilio";
import pool from "../db";
import { getBookingFlow } from "../appointments/getBookingFlow";
import { createAppointmentFromVoice } from "../appointments/createAppointmentFromVoice";
import { resolveVoiceScheduleValidation } from "../appointments/resolveVoiceScheduleValidation";
import { upsertVoiceCallState } from "./upsertVoiceCallState";
import { deleteVoiceCallState } from "./deleteVoiceCallState";
import { resolveVoiceIntentFromUtterance } from "./resolveVoiceIntentFromUtterance";
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

function twoSentencesMax(s: string) {
  const parts = (s || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[\.\?\!])\s+/);
  return parts.slice(0, 2).join(" ").trim();
}

function formatSuggestedStartForVoice(dateISO: string, locale: VoiceLocale) {
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
      timeZone: "America/New_York",
    }).format(date);
  }

  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
  }).format(date);
}

function buildBusyAlternativesPrompt(params: {
  locale: VoiceLocale;
  suggestedStarts: string[];
}) {
  const formatted = params.suggestedStarts
    .map((iso) => formatSuggestedStartForVoice(iso, params.locale))
    .filter(Boolean)
    .slice(0, 3);

  if (params.locale.startsWith("es")) {
    if (!formatted.length) {
      return "Ese horario ya no está disponible. ¿Qué otra hora te gustaría?";
    }

    return `Ese horario ya no está disponible. Tengo cerca de esa hora: ${formatted.join(
      ", "
    )}. ¿Cuál prefieres?`;
  }

  if (!formatted.length) {
    return "That time is no longer available. What other time would you prefer?";
  }

  return `That time is no longer available. I have these nearby times available: ${formatted.join(
    ", "
  )}. Which one do you prefer?`;
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
      ? resolveVoiceIntentFromUtterance(effectiveUserInput)
      : null;

  const wantsBooking =
    bookingAlreadyActive ||
    resolvedIntent === "booking";

  if (!wantsBooking) {
    return { handled: false, state };
  }

  const flow = await getBookingFlow(tenant.id);

  if (!flow.length) {
    throw new Error("BOOKING_FLOW_NOT_CONFIGURED");
  }

  if (typeof state.bookingStepIndex !== "number") {
    const firstStep = flow[0];

    state = {
      ...state,
      bookingStepIndex: 0,
      bookingData: {},
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
      bookingStepIndex: 0,
      bookingData: {},
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

  if (currentStep.expected_type === "confirmation") {
    const confirmationMetaSignal = await resolveVoiceMetaSignal({
      utterance: userInput,
      locale: currentLocale,
    });

    if (confirmationMetaSignal.intent === "affirm" || digits === "1") {
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

        const answersBySlot = buildAnswersBySlot({
          flow,
          bookingData: state.bookingData || {},
        });

        const appointment = await createAppointmentFromVoice({
          tenantId: tenant.id,
          answersBySlot,
          idempotencyKey: `voice:${callSid}`,
          settings: appointmentSettings,
        });

        void appointment;

        const successStep = resolveBookingSuccessStep({ flow });
        if (!successStep) {
          throw new Error("BOOKING_SUCCESS_STEP_NOT_CONFIGURED");
        }

        const bookingSpeechData = {
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
          bookingData: {},
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
          bookingData: {},
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
          const busyPrompt = buildBusyAlternativesPrompt({
            locale: currentLocale,
            suggestedStarts,
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
          cfg?.booking_error_message || "Hubo un problema al agendar la cita.";

        vr.say(
          { language: currentLocale as any, voice: voiceName },
          twoSentencesMax(failRaw)
        );
        vr.hangup();

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

    const confirmationRetryText = resolveBookingPromptText({
      locale: currentLocale,
      prompt: currentStep.prompt || "",
      promptTranslations: currentStep.prompt_translations || null,
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

      const ambiguousBaseText = currentLocale.startsWith("es")
        ? "Encontré varias opciones parecidas: {optionsText}. Por favor dime el nombre completo del servicio que quieres reservar."
        : currentLocale.startsWith("pt")
        ? "Encontrei várias opções parecidas: {optionsText}. Por favor diga o nome completo do serviço que você quer agendar."
        : "I found several similar options: {optionsText}. Please say the full service name you want to book.";

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

      const datetimeMetaSignal = await resolveVoiceMetaSignal({
      utterance: effectiveUserInput,
      locale: currentLocale,
    });

    if (
      datetimeMetaSignal.intent === "affirm" ||
      datetimeMetaSignal.intent === "reject"
    ) {
      const datetimeRetryText = resolveBookingRetryText({
        locale: currentLocale,
        retryPrompt: currentStep.retry_prompt || "",
        retryPromptTranslations: currentStep.retry_prompt_translations || null,
        fallbackPrompt: currentStep.prompt || "",
        fallbackPromptTranslations: currentStep.prompt_translations || null,
      });

      const retryPromptResolved = resolveBookingFlowSpeech({
        baseText: datetimeRetryText,
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

      logBotSay({
        callSid,
        to: didNumber || "ivr",
        text: retryPrompt,
        lang: currentLocale,
        context: `booking_retry:${currentStep.step_key}:meta_signal`,
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

        const availableTimes =
          scheduleValidation.reason === "schedule_not_available"
            ? scheduleValidation.availableTimes.join(", ")
            : "";

        const localizedRetryBase = resolveBookingRetryText({
          locale: currentLocale,
          retryPrompt: currentStep.retry_prompt || "",
          retryPromptTranslations: currentStep.retry_prompt_translations || null,
          fallbackPrompt: currentStep.prompt || "",
          fallbackPromptTranslations: currentStep.prompt_translations || null,
        });

        const promptTemplate =
          scheduleValidation.reason === "schedule_not_available" &&
          unavailablePrompt
            ? unavailablePrompt
            : localizedRetryBase;

        const retryPromptResolved = resolveBookingFlowSpeech({
          baseText: promptTemplate,
          locale: currentLocale,
          bookingData: {
            ...currentBookingData,
            requested_service: String(
            currentBookingData.service || ""
            ).trim(),
            requested_datetime: rawDatetime,
            available_times: availableTimes,
          },
          callerE164,
        });

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