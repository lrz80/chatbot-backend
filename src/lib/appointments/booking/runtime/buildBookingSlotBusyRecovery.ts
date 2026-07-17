// src/lib/appointments/booking/runtime/buildBookingSlotBusyRecovery.ts

import type {
  CallState,
  VoiceLocale,
} from "../../../voice/types";

import {
  resolveBookingFlowSpeech,
  resolveBookingRetryText,
} from "../../../voice/voiceBookingHelpers";

import {
  twoSentencesMax,
} from "../../../voice/speechFormatting";

type BookingFlowStep = {
  step_key?: string;
  prompt?: string | null;
  prompt_translations?: Record<string, unknown> | null;
  retry_prompt_translations?: Record<string, unknown> | null;
  retry_prompt?: string | null;
  expected_type?: string | null;
  validation_config?: Record<string, any> | null;
};

export type BuildBookingSlotBusyRecoveryParams = {
  flow: BookingFlowStep[];
  state: CallState;
  currentLocale: VoiceLocale;
  callerPhone: string | null;
  timeZone: string;
  suggestedStarts: string[];
};

export type BuildBookingSlotBusyRecoveryResult = {
  state: CallState;
  prompt: string;
  datetimeStepIndex: number;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function findDatetimeStepIndex(
  flow: BookingFlowStep[]
): number {
  return flow.findIndex((step) => {
    const slot =
      typeof step.validation_config?.slot ===
      "string"
        ? step.validation_config.slot.trim()
        : "";

    return (
      clean(step.step_key) === "datetime" ||
      slot === "datetime"
    );
  });
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
      ? (params.translations as Record<
          string,
          unknown
        >)
      : null;

  const exactTranslation = clean(
    translations?.[locale]
  );

  if (exactTranslation) {
    return exactTranslation;
  }

  const localePrefix =
    locale.split("-")[0]?.toLowerCase() || "";

  const sameLanguageTranslation =
    translations
      ? Object.entries(translations).find(
          ([key, value]) => {
            const keyPrefix =
              clean(key)
                .split("-")[0]
                ?.toLowerCase() || "";

            return (
              keyPrefix === localePrefix &&
              clean(value)
            );
          }
        )
      : null;

  if (sameLanguageTranslation) {
    return clean(
      sameLanguageTranslation[1]
    );
  }

  return localePrefix === "es"
    ? baseText
    : "";
}

function formatSuggestedStart(
  dateISO: string,
  locale: VoiceLocale,
  timeZone: string
): string {
  const date = new Date(dateISO);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
  }).format(date);
}

export function buildBookingSlotBusyRecovery(
  params: BuildBookingSlotBusyRecoveryParams
): BuildBookingSlotBusyRecoveryResult {
  const datetimeStepIndex =
    findDatetimeStepIndex(params.flow);

  if (datetimeStepIndex === -1) {
    throw new Error(
      "BOOKING_DATETIME_STEP_NOT_FOUND"
    );
  }

  const datetimeStep =
    params.flow[datetimeStepIndex];

  const unavailablePromptText =
    resolveLocalizedValidationText({
      locale: params.currentLocale,
      baseText:
        datetimeStep.validation_config
          ?.unavailable_prompt,
      translations:
        datetimeStep.validation_config
          ?.unavailable_prompt_translations,
    });

  const datetimeRetryText =
    resolveBookingRetryText({
      locale: params.currentLocale,
      retryPrompt:
        datetimeStep.retry_prompt || "",
      retryPromptTranslations:
        datetimeStep
          .retry_prompt_translations ||
        null,
      fallbackPrompt:
        datetimeStep.prompt || "",
      fallbackPromptTranslations:
        datetimeStep.prompt_translations ||
        null,
    });

  const formattedSuggestedTimes =
    params.suggestedStarts
      .map((iso) =>
        formatSuggestedStart(
          iso,
          params.currentLocale,
          params.timeZone
        )
      )
      .filter(Boolean)
      .slice(0, 3);

  const suggestedTimesText =
    formattedSuggestedTimes.join(", ");

  const serviceName =
    clean(
      params.state.bookingData
        ?.service_display
    ) ||
    clean(
      params.state.bookingData?.service
    );

  const requestedDatetime =
    clean(
      params.state.bookingData
        ?.datetime_display
    ) ||
    clean(
      params.state.bookingData?.datetime
    );

  const resolvedPrompt =
    resolveBookingFlowSpeech({
      baseText:
        unavailablePromptText ||
        datetimeRetryText,
      locale: params.currentLocale,
      bookingData: {
        ...(params.state.bookingData || {}),
        requested_service: serviceName,
        requested_datetime:
          requestedDatetime,
        available_times:
          suggestedTimesText,
        suggested_times:
          suggestedTimesText,
      },
      callerE164: params.callerPhone,
    });

  const fallbackPrompt =
    params.currentLocale.startsWith("es")
      ? `Ese horario ya no está disponible para ${
          serviceName || "este servicio"
        }. Las opciones más cercanas son ${
          suggestedTimesText ||
          "otras horas disponibles"
        }. ¿Cuál prefieres?`
      : `That time is no longer available for ${
          serviceName || "this service"
        }. The closest options are ${
          suggestedTimesText ||
          "other available times"
        }. Which one do you prefer?`;

  const prompt = twoSentencesMax(
    clean(resolvedPrompt) ||
      fallbackPrompt
  );

  const nextState: CallState = {
    ...params.state,

    awaiting: false,
    pendingType: null,
    awaitingNumber: false,
    smsSent: false,

    bookingStepIndex:
      datetimeStepIndex,

    pendingBookingStepKey:
      clean(datetimeStep.step_key),

    pendingBookingStepPrompt:
      prompt,

    pendingBookingStepRequired:
      true,

    pendingBookingStepSlot:
      "datetime",

    pendingBookingStepExpectedType:
      clean(
        datetimeStep.expected_type ||
        "datetime"
      ),

    pendingBookingStepValidationConfig:
      datetimeStep.validation_config ||
      null,

    bookingTurnStatus:
      "waiting_user_answer",

    bookingData: {
      ...(params.state.bookingData || {}),

      __last_booking_error:
        "SLOT_BUSY",

      __booking_busy_retry: "1",

      __booking_busy_suggested_starts:
        JSON.stringify(
          params.suggestedStarts
        ),
    },
  };

  return {
    state: nextState,
    prompt,
    datetimeStepIndex,
  };
}