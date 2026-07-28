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

type LocalDateParts = {
  year: number;
  month: number;
  day: number;
};

function getLocalDateParts(
  date: Date,
  timeZone: string
): LocalDateParts | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = Number(
    parts.find((part) => part.type === "year")?.value
  );

  const month = Number(
    parts.find((part) => part.type === "month")?.value
  );

  const day = Number(
    parts.find((part) => part.type === "day")?.value
  );

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return null;
  }

  return {
    year,
    month,
    day,
  };
}

function buildLocalDateKey(
  parts: LocalDateParts
): string {
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

function getCalendarDayDifference(
  target: LocalDateParts,
  reference: LocalDateParts
): number {
  const targetUtc = Date.UTC(
    target.year,
    target.month - 1,
    target.day
  );

  const referenceUtc = Date.UTC(
    reference.year,
    reference.month - 1,
    reference.day
  );

  return Math.round(
    (targetUtc - referenceUtc) /
      (24 * 60 * 60 * 1000)
  );
}

function capitalizeFirst(value: string): string {
  if (!value) {
    return "";
  }

  return (
    value.charAt(0).toLocaleUpperCase() +
    value.slice(1)
  );
}

function formatLocalizedList(
  values: string[],
  locale: VoiceLocale
): string {
  const cleanValues = values
    .map((value) => clean(value))
    .filter(Boolean);

  if (cleanValues.length === 0) {
    return "";
  }

  if (cleanValues.length === 1) {
    return cleanValues[0];
  }

  const language =
    clean(locale)
      .split("-")[0]
      ?.toLowerCase() || "en";

  const conjunction =
    language === "es"
      ? "o"
      : language === "pt"
        ? "ou"
        : "or";

  if (cleanValues.length === 2) {
    return `${cleanValues[0]} ${conjunction} ${cleanValues[1]}`;
  }

  return `${cleanValues
    .slice(0, -1)
    .join(", ")} ${conjunction} ${
    cleanValues[cleanValues.length - 1]
  }`;
}

function formatSuggestedStarts(params: {
  suggestedStarts: string[];
  locale: VoiceLocale;
  timeZone: string;
  now?: Date;
  limit?: number;
}): string {
  const locale =
    clean(params.locale) || "en-US";

  const now = params.now || new Date();

  const limit =
    typeof params.limit === "number" &&
    params.limit > 0
      ? Math.floor(params.limit)
      : 3;

  const referenceDateParts =
    getLocalDateParts(now, params.timeZone);

  if (!referenceDateParts) {
    return "";
  }

  const timeFormatter =
    new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: params.timeZone,
    });

  const weekdayFormatter =
    new Intl.DateTimeFormat(locale, {
      weekday: "long",
      timeZone: params.timeZone,
    });

  const relativeDayFormatter =
    new Intl.RelativeTimeFormat(locale, {
      numeric: "auto",
    });

  const groups = new Map<
    string,
    {
      date: Date;
      dateParts: LocalDateParts;
      times: string[];
    }
  >();

  for (
    const dateISO of params.suggestedStarts.slice(
      0,
      limit
    )
  ) {
    const date = new Date(dateISO);

    if (Number.isNaN(date.getTime())) {
      continue;
    }

    const dateParts = getLocalDateParts(
      date,
      params.timeZone
    );

    if (!dateParts) {
      continue;
    }

    const dateKey =
      buildLocalDateKey(dateParts);

    const timeText =
      timeFormatter.format(date);

    const existingGroup =
      groups.get(dateKey);

    if (existingGroup) {
      if (
        !existingGroup.times.includes(timeText)
      ) {
        existingGroup.times.push(timeText);
      }

      continue;
    }

    groups.set(dateKey, {
      date,
      dateParts,
      times: [timeText],
    });
  }

  const formattedGroups = Array.from(
    groups.values()
  ).map((group) => {
    const dayDifference =
      getCalendarDayDifference(
        group.dateParts,
        referenceDateParts
      );

    const dayLabel =
      dayDifference === 0 ||
      dayDifference === 1
        ? relativeDayFormatter.format(
            dayDifference,
            "day"
          )
        : weekdayFormatter.format(
            group.date
          );

    const timesText =
      formatLocalizedList(
        group.times,
        params.locale
      );

    return `${capitalizeFirst(
      dayLabel
    )}: ${timesText}`;
  });

  return formattedGroups.join(". ");
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

  const suggestedTimesText =
    formatSuggestedStarts({
      suggestedStarts:
        params.suggestedStarts,
      locale: params.currentLocale,
      timeZone: params.timeZone,
      limit: 3,
    });

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