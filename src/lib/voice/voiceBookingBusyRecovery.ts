// src/lib/voice/voiceBookingBusyRecovery.ts

import { twiml } from "twilio";
import { upsertVoiceCallState } from "./upsertVoiceCallState";
import {
  resolveBookingFlowSpeech,
  resolveBookingRetryText,
} from "./voiceBookingHelpers";
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

export type ExecuteCanonicalBookingSlotBusyRecoveryParams = {
  flow: BookingFlowStep[];
  state: CallState;
  tenantId: string;
  callSid: string;
  currentLocale: VoiceLocale;
  callerE164: string | null;
  timeZone: string;
  suggestedStarts: string[];
};

export type ExecuteCanonicalBookingSlotBusyRecoveryResult = {
  state: CallState;
  prompt: string;
  context: "booking_busy_retry:datetime";
  datetimeStepIndex: number;
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

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function resolveLocalizedValidationText(params: {
  locale: VoiceLocale;
  baseText?: unknown;
  translations?: unknown;
}): string {
  const locale = clean(params.locale);
  const baseText = clean(params.baseText);

  const translations =
    params.translations &&
    typeof params.translations === "object" &&
    !Array.isArray(params.translations)
      ? (params.translations as Record<string, unknown>)
      : null;

  const exactTranslation = clean(translations?.[locale]);

  if (exactTranslation) {
    return exactTranslation;
  }

  const localePrefix = locale.split("-")[0]?.toLowerCase() || "";

  const sameLanguageTranslation = translations
    ? Object.entries(translations).find(([key, value]) => {
        const keyPrefix = clean(key).split("-")[0]?.toLowerCase() || "";
        return keyPrefix && keyPrefix === localePrefix && clean(value);
      })
    : null;

  if (sameLanguageTranslation) {
    return clean(sameLanguageTranslation[1]);
  }

  /**
   * Legacy safety:
   * The base validation_config.unavailable_prompt may be stored in the tenant's
   * original dashboard language. Do not leak that base text into a different
   * runtime locale. For Spanish calls we keep the base field because existing
   * flows commonly store this unavailable prompt in Spanish.
   *
   * For non-Spanish calls, caller-facing fallback copy is generated below using
   * currentLocale, service, and suggested times.
   */
  if (localePrefix === "es") {
    return baseText;
  }

  return "";
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

export async function executeCanonicalBookingSlotBusyRecovery(
  params: ExecuteCanonicalBookingSlotBusyRecoveryParams
): Promise<ExecuteCanonicalBookingSlotBusyRecoveryResult> {
  const {
    flow,
    state,
    tenantId,
    callSid,
    currentLocale,
    callerE164,
    timeZone,
    suggestedStarts,
  } = params;

  const datetimeStepIndex = findDatetimeStepIndex(flow);

  if (datetimeStepIndex === -1) {
    throw new Error("BOOKING_DATETIME_STEP_NOT_FOUND");
  }

  const datetimeStep = flow[datetimeStepIndex];

  const unavailablePromptText = resolveLocalizedValidationText({
    locale: currentLocale,
    baseText: datetimeStep.validation_config?.unavailable_prompt,
    translations: datetimeStep.validation_config?.unavailable_prompt_translations,
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

  const busyPromptResolved = await resolveBookingFlowSpeech({
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

  const busyPromptFallback = currentLocale.startsWith("es")
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

  return {
    state: nextState,
    prompt: busyPrompt,
    context: "booking_busy_retry:datetime",
    datetimeStepIndex,
  };
}

export async function handleBookingSlotBusyRecovery(
  params: HandleBookingSlotBusyRecoveryParams
): Promise<{ state: CallState; twiml: string }> {
  const canonical = await executeCanonicalBookingSlotBusyRecovery({
    flow: params.flow,
    state: params.state,
    tenantId: params.tenantId,
    callSid: params.callSid,
    currentLocale: params.currentLocale,
    callerE164: params.callerE164,
    timeZone: params.timeZone,
    suggestedStarts: params.suggestedStarts,
  });

  const gather = createBookingGather({
    vr: params.vr,
    locale: params.currentLocale,
  });

  gather.say(
    { language: params.currentLocale as any, voice: params.voiceName as any },
    canonical.prompt
  );

  params.logBotSay({
    callSid: params.callSid,
    to: params.didNumber || "ivr",
    text: canonical.prompt,
    lang: params.currentLocale,
    context: canonical.context,
  });

  return {
    state: canonical.state,
    twiml: params.vr.toString(),
  };
}