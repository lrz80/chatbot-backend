//src/lib/voice/booking/handleBookingDatetimeStep.ts
import { twiml } from "twilio";
import type { CallState, VoiceLocale } from "../types";
import { resolveVoiceScheduleValidation } from "../../appointments/resolveVoiceScheduleValidation";
import {
  resolveBookingFlowSpeech,
  resolveBookingRetryText,
} from "../voiceBookingHelpers";
import { twoSentencesMax } from "../speechFormatting";
import { upsertVoiceCallState } from "../upsertVoiceCallState";

type BookingStepLike = {
  step_key: string;
  prompt?: string | null;
  prompt_translations?: Record<string, string> | null;
  retry_prompt?: string | null;
  retry_prompt_translations?: Record<string, string> | null;
  validation_config?: {
    slot?: string;
    unavailable_prompt?: string;
  } | null;
};

type HandleBookingDatetimeStepParams = {
  vr: twiml.VoiceResponse;
  tenantId: string;
  callSid: string;
  didNumber: string;
  currentStep: BookingStepLike;
  currentIndex: number;
  currentLocale: VoiceLocale;
  voiceName: any;
  callerE164: string | null;
  state: CallState;
  resolvedStepValue: string;
  createBookingGather: (params: {
    vr: twiml.VoiceResponse;
    locale: VoiceLocale;
    isPhoneStep?: boolean;
    isConfirmationStep?: boolean;
  }) => ReturnType<twiml.VoiceResponse["gather"]>;
  logBotSay: (input: {
    callSid: string;
    to: string;
    text: string;
    lang?: string;
    context?: string;
  }) => void;
};

type HandleBookingDatetimeStepResult =
  | {
      handled: false;
      nextState: CallState;
      resolvedValue: string;
    }
  | {
      handled: true;
      state: CallState;
      twiml: string;
    };

function assertNonEmptyBookingSpeech(input: {
  text: string;
  stepKey: string;
  field: "prompt" | "retry_prompt" | "unavailable_prompt";
}) {
  const value = String(input.text || "").trim();

  if (!value) {
    throw new Error(
      `BOOKING_FLOW_EMPTY_SPEECH:${input.stepKey}:${input.field}`
    );
  }

  return value;
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
    const weekday = new Intl.DateTimeFormat("es-ES", {
      weekday: "long",
      timeZone,
    }).format(date);

    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone,
    }).formatToParts(date);

    const hour = parts.find((part) => part.type === "hour")?.value || "";
    const minute = parts.find((part) => part.type === "minute")?.value || "00";
    const dayPeriod = (
      parts.find((part) => part.type === "dayPeriod")?.value || ""
    ).toLowerCase();

    const spokenPeriod = dayPeriod === "am" ? "de la mañana" : "de la tarde";

    if (minute === "00") {
      return `${weekday}, ${hour} ${spokenPeriod}`;
    }

    return `${weekday}, ${hour}:${minute} ${spokenPeriod}`;
  }

  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
  }).format(date);
}

export async function handleBookingDatetimeStep(
  params: HandleBookingDatetimeStepParams
): Promise<HandleBookingDatetimeStepResult> {
  const {
    vr,
    tenantId,
    callSid,
    didNumber,
    currentStep,
    currentIndex,
    currentLocale,
    voiceName,
    callerE164,
    state,
    resolvedStepValue,
    createBookingGather,
    logBotSay,
  } = params;

  const currentBookingData = {
    ...(state.bookingData || {}),
    [currentStep.step_key]: resolvedStepValue,
  };

  const referenceSuggestedStarts =
    typeof state.bookingData?.__datetime_reference_suggested_starts === "string"
      ? (() => {
          try {
            const parsed = JSON.parse(
              state.bookingData.__datetime_reference_suggested_starts
            );

            return Array.isArray(parsed)
              ? parsed.map((value) => String(value || "").trim()).filter(Boolean)
              : [];
          } catch {
            return [];
          }
        })()
      : [];

  const serviceName = String(
    currentBookingData.service || currentBookingData["service"] || ""
  ).trim();

  const rawDatetime = String(resolvedStepValue || "").trim();

  if (!rawDatetime) {
    const nextState = {
      ...state,
      bookingStepIndex: currentIndex,
      bookingData: currentBookingData,
    };

    await upsertVoiceCallState({
      callSid,
      tenantId,
      lang: nextState.lang ?? currentLocale,
      turn: nextState.turn ?? 0,
      awaiting: false,
      pendingType: null,
      awaitingNumber: false,
      altDest: nextState.altDest ?? null,
      smsSent: nextState.smsSent ?? false,
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
      state: nextState,
      twiml: vr.toString(),
    };
  }

  if (!serviceName) {
    return {
      handled: false,
      nextState: state,
      resolvedValue: resolvedStepValue,
    };
  }

  const scheduleValidation = await resolveVoiceScheduleValidation({
    tenantId,
    serviceName,
    rawDatetime,
    channel: "voice",
    referenceSuggestedStarts,
  });

  if (!scheduleValidation.ok) {
    const bookingDataWithSuggestedStarts = {
      ...currentBookingData,
      __datetime_reference_suggested_starts: JSON.stringify(
        Array.isArray(scheduleValidation.suggestedStarts)
          ? scheduleValidation.suggestedStarts
          : []
      ),
    };

    const nextState = {
      ...state,
      bookingStepIndex: currentIndex,
      bookingData: bookingDataWithSuggestedStarts,
    };

    await upsertVoiceCallState({
      callSid,
      tenantId,
      lang: nextState.lang ?? currentLocale,
      turn: nextState.turn ?? 0,
      awaiting: false,
      pendingType: null,
      awaitingNumber: false,
      altDest: nextState.altDest ?? null,
      smsSent: nextState.smsSent ?? false,
      bookingStepIndex: currentIndex,
      bookingData: bookingDataWithSuggestedStarts,
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
      (
        scheduleValidation.reason === "schedule_not_available" ||
        scheduleValidation.reason === "lead_time_not_met"
      ) && unavailablePrompt
        ? unavailablePrompt
        : localizedRetryBase;

    const rawAvailableTimes =
      scheduleValidation.reason === "schedule_not_available" ||
      scheduleValidation.reason === "lead_time_not_met"
        ? Array.isArray(scheduleValidation.availableTimes)
          ? scheduleValidation.availableTimes
          : []
        : [];

    const availableTimes = rawAvailableTimes
      .map((value) => String(value || "").trim())
      .filter(Boolean);

    const availableTimesText = availableTimes.join(", ");

    const suggestedStarts =
      (
        scheduleValidation.reason === "schedule_not_available" ||
        scheduleValidation.reason === "lead_time_not_met"
      ) &&
      Array.isArray(scheduleValidation.suggestedStarts)
        ? scheduleValidation.suggestedStarts
            .map((value) => String(value || "").trim())
            .filter(Boolean)
        : [];

    const formattedSuggestedTimes = suggestedStarts
      .map((iso) =>
        formatSuggestedStartForVoice(
          iso,
          currentLocale,
          String(scheduleValidation.timeZone || "").trim() || "America/New_York"
        )
      )
      .filter(Boolean)
      .slice(0, 3);

    const suggestedTimesText = formattedSuggestedTimes.join(", ");

    const retryPromptResolved = resolveBookingFlowSpeech({
      baseText: promptTemplate,
      locale: currentLocale,
      bookingData: {
        ...bookingDataWithSuggestedStarts,
        requested_service: String(currentBookingData.service || "").trim(),
        requested_datetime: rawDatetime,
        available_times: availableTimesText,
        suggested_times: suggestedTimesText || availableTimesText,
      },
      callerE164,
    });

    const retryPromptFinal =
      suggestedTimesText || availableTimesText
        ? retryPromptResolved
        : currentLocale.startsWith("es")
        ? `Ese horario no está disponible para ${
            String(currentBookingData.service || "").trim() || "este servicio"
          }. ¿Qué otro día y hora te gustaría?`
        : currentLocale.startsWith("pt")
        ? `Esse horário não está disponível para ${
            String(currentBookingData.service || "").trim() || "este serviço"
          }. Que outro dia e horário você gostaria?`
        : `That time is not available for ${
            String(currentBookingData.service || "").trim() || "this service"
          }. What other day and time would you like?`;

    const retryPrompt = twoSentencesMax(
      assertNonEmptyBookingSpeech({
        text: retryPromptFinal,
        stepKey: currentStep.step_key,
        field:
          (
            scheduleValidation.reason === "schedule_not_available" ||
            scheduleValidation.reason === "lead_time_not_met"
          ) && unavailablePrompt
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
      state: nextState,
      twiml: vr.toString(),
    };
  }

  const resolvedDatetimeIso = scheduleValidation.requestedAt.toISOString();

  const resolvedDatetimeDisplay =
    formatSuggestedStartForVoice(
      resolvedDatetimeIso,
      currentLocale,
      String(scheduleValidation.timeZone || "").trim() || "America/New_York"
    ) || rawDatetime;

  const nextBookingData = {
    ...currentBookingData,
    [currentStep.step_key]: rawDatetime,
    datetime: rawDatetime,
    datetime_iso: resolvedDatetimeIso,
    datetime_display: resolvedDatetimeDisplay,
    __datetime_reference_suggested_starts: JSON.stringify([]),
  };

  const nextState: CallState = {
    ...state,
    bookingData: nextBookingData,
  };

  return {
    handled: false,
    nextState,
    resolvedValue: rawDatetime,
  };
}