//src/lib/voice/handleVoiceBookingTurn.ts
import { twiml } from "twilio";
import pool from "../db";
import { getBookingFlow } from "../appointments/getBookingFlow";
import { createAppointmentFromVoice } from "../appointments/createAppointmentFromVoice";
import { resolveVoiceScheduleValidation } from "../appointments/resolveVoiceScheduleValidation";
import { upsertVoiceCallState } from "./upsertVoiceCallState";
import { deleteVoiceCallState } from "./deleteVoiceCallState";
import { CallState, VoiceLocale } from "./types";
import {
  buildAnswersBySlot,
  buildBookingPromptVariables,
  renderBookingTemplate,
  resolveBookingFlowSpeech,
  resolveBookingSuccessStep,
  resolvePhoneFromVoiceInput,
  resolveVoiceBookingService,
} from "./voiceBookingHelpers";

function twoSentencesMax(s: string) {
  const parts = (s || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[\.\?\!])\s+/);
  return parts.slice(0, 2).join(" ").trim();
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

function saidYes(t: string) {
  const s = (t || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  return /\b(si|si por favor|claro|dale|ok|okay|porfa|envialo|mandalo|hazlo|yes|yep|please do|send it|text it)\b/u.test(
    s
  );
}

function saidNo(t: string) {
  const s = (t || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  return /\b(no|no gracias|mejor no|luego|despues|mas tarde|not now|dont)\b/u.test(
    s
  );
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

  const flow = await getBookingFlow(tenant.id);

  if (!effectiveUserInput && typeof state.bookingStepIndex !== "number") {
    return { handled: false, state };
  }

  const wantsBooking =
    typeof state.bookingStepIndex === "number" ||
    (effectiveUserInput &&
      cfg &&
      typeof effectiveUserInput === "string" &&
      (() => {
        const s = effectiveUserInput.toLowerCase();
        return /(reserv|agend|cita|appointment|book|booking)/i.test(s);
      })());

  if (!wantsBooking) {
    return { handled: false, state };
  }

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

    const askResolved = await resolveBookingFlowSpeech({
      baseText: firstStep.prompt || "",
      locale: currentLocale,
      bookingData: state.bookingData || {},
      callerE164,
    });

    const ask = twoSentencesMax(
      assertNonEmptyBookingSpeech({
        text: askResolved,
        stepKey: firstStep.step_key,
        field: "prompt",
      })
    );

    const gather = vr.gather({
      input: ["speech"] as any,
      action: "/webhook/voice-response",
      method: "POST",
      language: currentLocale as any,
      speechTimeout: "auto",
      timeout: 7,
      actionOnEmptyResult: true,
      bargeIn: true,
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
    if (saidYes(userInput) || digits === "1") {
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

        const successPromptResolved = await resolveBookingFlowSpeech({
          baseText: successStep.prompt || "",
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

        const gather = vr.gather({
          input: ["speech", "dtmf"] as any,
          numDigits: 1,
          action: "/webhook/voice-response",
          method: "POST",
          language: currentLocale as any,
          speechTimeout: "auto",
          timeout: 7,
          actionOnEmptyResult: true,
          bargeIn: true,
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
      } catch (err) {
        console.error("❌ Error creando cita:", err);

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

    if (saidNo(userInput) || digits === "2") {
      await deleteVoiceCallState(callSid);

      const cancelRaw = cfg?.booking_cancel_message || "No se agendó la cita.";

      const gather = vr.gather({
        input: ["speech", "dtmf"] as any,
        numDigits: 1,
        action: "/webhook/voice-response",
        method: "POST",
        language: currentLocale as any,
      });

      gather.say(
        { language: currentLocale as any, voice: voiceName },
        twoSentencesMax(cancelRaw)
      );

      return {
        handled: true,
        state: {},
        twiml: vr.toString(),
      };
    }

    const retry = twoSentencesMax(
      await resolveBookingFlowSpeech({
        baseText: currentStep.prompt || "",
        locale: currentLocale,
        bookingData: state.bookingData || {},
        callerE164,
      })
    );

    const gather = vr.gather({
      input: ["speech", "dtmf"] as any,
      numDigits: 1,
      action: "/webhook/voice-response",
      method: "POST",
      language: currentLocale as any,
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
      const gather = vr.gather({
        input: ["speech", "dtmf"] as any,
        numDigits: 1,
        action: "/webhook/voice-response",
        method: "POST",
        language: currentLocale as any,
        speechTimeout: "auto",
        timeout: 7,
        actionOnEmptyResult: true,
        bargeIn: true,
      });

      const retryPromptResolved = await resolveBookingFlowSpeech({
        baseText: currentStep.retry_prompt || currentStep.prompt || "",
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

    const prompt = twoSentencesMax(
      await resolveBookingFlowSpeech({
        baseText: nextStep.prompt || "",
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

    const gather = vr.gather({
      input:
        isPhoneStep || isConfirmationStep
          ? (["speech", "dtmf"] as any)
          : (["speech"] as any),
      numDigits: isPhoneStep ? 15 : isConfirmationStep ? 1 : undefined,
      action: "/webhook/voice-response",
      method: "POST",
      language: currentLocale as any,
      speechTimeout: "auto",
      timeout: 7,
      actionOnEmptyResult: true,
      bargeIn: true,
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
      const retryPromptResolved = await resolveBookingFlowSpeech({
        baseText: currentStep.retry_prompt || currentStep.prompt || "",
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

      const gather = vr.gather({
        input: ["speech"] as any,
        action: "/webhook/voice-response",
        method: "POST",
        language: currentLocale as any,
        speechTimeout: "auto",
        timeout: 7,
        actionOnEmptyResult: true,
        bargeIn: true,
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

      const ambiguousPrompt = await resolveBookingFlowSpeech({
        baseText:
          "I found several similar options: ${optionsText}. Please say the full service name you want to book.",
        locale: currentLocale,
        bookingData: {
          ...(state.bookingData || {}),
          optionsText,
          available_options: optionsText,
        },
        callerE164,
      });

      const gather = vr.gather({
        input: ["speech"] as any,
        action: "/webhook/voice-response",
        method: "POST",
        language: currentLocale as any,
        speechTimeout: "auto",
        timeout: 7,
        actionOnEmptyResult: true,
        bargeIn: true,
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

    const localizedServiceDisplay = await resolveBookingFlowSpeech({
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

        const promptTemplate =
          scheduleValidation.reason === "schedule_not_available" &&
          unavailablePrompt
            ? unavailablePrompt
            : currentStep.retry_prompt || currentStep.prompt;

        const retryPromptResolved = await resolveBookingFlowSpeech({
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

        const gather = vr.gather({
          input: ["speech"] as any,
          action: "/webhook/voice-response",
          method: "POST",
          language: currentLocale as any,
          speechTimeout: "auto",
          timeout: 7,
          actionOnEmptyResult: true,
          bargeIn: true,
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

  const promptResolved = await resolveBookingFlowSpeech({
    baseText: nextStep.prompt || "",
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

  const gather = vr.gather({
    input:
      isPhoneStep || isConfirmationStep
        ? (["speech", "dtmf"] as any)
        : (["speech"] as any),
    numDigits: isPhoneStep ? 15 : isConfirmationStep ? 1 : undefined,
    action: "/webhook/voice-response",
    method: "POST",
    language: currentLocale as any,
    speechTimeout: "auto",
    timeout: 7,
    actionOnEmptyResult: true,
    bargeIn: true,
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