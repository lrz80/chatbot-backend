//src/lib/voice/voiceBookingBusyRecovery.ts
import { twiml } from "twilio";
import { upsertVoiceCallState } from "./upsertVoiceCallState";
import { resolveBookingFlowSpeech, resolveBookingRetryText, resolveBookingPromptText } from "./voiceBookingHelpers";
import { twoSentencesMax } from "./speechFormatting";
import type { CallState, VoiceLocale } from "./types";

type BookingFlowStep = {
  step_key: string;
  prompt?: string | null;
  prompt_translations?: Record<string, string> | null;
  retry_prompt?: string | null;
  retry_prompt_translations?: Record<string, string> | null;
  validation_config?: Record<string, any> | null;
};

type HandleBookingSlotBusyRecoveryParams = {
  vr: twiml.VoiceResponse;
  flow: BookingFlowStep[];
  state: CallState;
  tenantId: string;
  callSid: string;
  currentLocale: VoiceLocale;
  voiceName: string;
  didNumber: string;
  callerE164: string | null;
  timeZone: string;
  suggestedStarts: string[];
  logBotSay: (input: {
    callSid: string;
    to: string;
    text: string;
    lang?: string;
    context?: string;
  }) => void;
};

function createBookingGather(params: {
  vr: twiml.VoiceResponse;
  locale: VoiceLocale;
}) {
  return params.vr.gather({
    input: ["speech"] as any,
    action: "/webhook/voice-response",
    method: "POST",
    language: params.locale as any,
    speechTimeout: "1",
    timeout: 5,
    actionOnEmptyResult: true,
    bargeIn: true,
  });
}

function findDatetimeStepIndex(flow: BookingFlowStep[]): number {
  return flow.findIndex((step) => {
    const slot =
      typeof step.validation_config?.slot === "string"
        ? step.validation_config.slot.trim()
        : "";

    return step.step_key === "datetime" || slot === "datetime";
  });
}

function formatSuggestedStartForVoice(
  dateISO: string,
  locale: VoiceLocale,
  timeZone: string
): string {
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

export async function handleBookingSlotBusyRecovery(
  params: HandleBookingSlotBusyRecoveryParams
): Promise<{ state: CallState; twiml: string }> {
  const {
    vr,
    flow,
    state,
    tenantId,
    callSid,
    currentLocale,
    voiceName,
    didNumber,
    callerE164,
    timeZone,
    suggestedStarts,
    logBotSay,
  } = params;

  const datetimeStepIndex = findDatetimeStepIndex(flow);

  if (datetimeStepIndex === -1) {
    throw new Error("BOOKING_DATETIME_STEP_NOT_FOUND");
  }

  const datetimeStep = flow[datetimeStepIndex];

  const unavailablePromptText = resolveBookingPromptText({
    locale: currentLocale,
    prompt:
      typeof datetimeStep.validation_config?.unavailable_prompt === "string"
        ? datetimeStep.validation_config.unavailable_prompt
        : "",
    promptTranslations:
      datetimeStep.validation_config?.unavailable_prompt_translations || null,
  });

  const datetimeRetryText = resolveBookingRetryText({
    locale: currentLocale,
    retryPrompt: datetimeStep.retry_prompt || "",
    retryPromptTranslations: datetimeStep.retry_prompt_translations || null,
    fallbackPrompt: datetimeStep.prompt || "",
    fallbackPromptTranslations: datetimeStep.prompt_translations || null,
  });

  const formattedSuggestedTimes = suggestedStarts
    .map((iso) => formatSuggestedStartForVoice(iso, currentLocale, timeZone))
    .filter(Boolean)
    .slice(0, 3);

  const suggestedTimesText = formattedSuggestedTimes.join(", ");

  const busyPromptResolved = resolveBookingFlowSpeech({
    baseText: unavailablePromptText.trim() || datetimeRetryText.trim(),
    locale: currentLocale,
    bookingData: {
      ...(state.bookingData || {}),
      requested_service: String(
        state.bookingData?.service_display ||
          state.bookingData?.service ||
          ""
      ).trim(),
      requested_datetime: String(
        state.bookingData?.datetime_display ||
          state.bookingData?.datetime ||
          ""
      ).trim(),
      available_times: suggestedTimesText,
      suggested_times: suggestedTimesText,
    },
    callerE164,
  });

  const busyPromptFallback =
    currentLocale.startsWith("es")
      ? `Ese horario ya no está disponible para ${
          String(
            state.bookingData?.service_display ||
              state.bookingData?.service ||
              "este servicio"
          ).trim() || "este servicio"
        }. Las opciones más cercanas son ${
          suggestedTimesText || "otras horas disponibles"
        }. ¿Cuál prefieres?`
      : `That time is no longer available for ${
          String(
            state.bookingData?.service_display ||
              state.bookingData?.service ||
              "this service"
          ).trim() || "this service"
        }. The closest options are ${
          suggestedTimesText || "other available times"
        }. Which one do you prefer?`;

  const busyPrompt = twoSentencesMax(
    (busyPromptResolved || "").trim() || busyPromptFallback
  );

  const nextBookingData = {
    ...(state.bookingData || {}),
    __last_booking_error: "SLOT_BUSY",
    __booking_busy_retry: "1",
    __booking_busy_suggested_starts: JSON.stringify(suggestedStarts),
  };

  const nextState: CallState = {
    ...state,
    awaiting: false,
    pendingType: null,
    awaitingNumber: false,
    smsSent: false,
    bookingStepIndex: datetimeStepIndex,
    bookingData: nextBookingData,
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
    smsSent: false,
    bookingStepIndex: datetimeStepIndex,
    bookingData: nextBookingData,
  });

  const gather = createBookingGather({
    vr,
    locale: currentLocale,
  });

  gather.say(
    { language: currentLocale as any, voice: voiceName as any },
    busyPrompt
  );

  logBotSay({
    callSid,
    to: didNumber || "ivr",
    text: busyPrompt,
    lang: currentLocale,
    context: "booking_busy_retry:datetime",
  });

  return {
    state: nextState,
    twiml: vr.toString(),
  };
}