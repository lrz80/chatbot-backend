// src/lib/voice/booking/handleBookingDatetimeStep.ts
import { twiml } from "twilio";
import type { CallState, VoiceLocale } from "../types";
import { resolveVoiceScheduleValidation } from "../../appointments/resolveVoiceScheduleValidation";
import {
  resolveBookingFlowSpeech,
  resolveBookingRetryText,
} from "../voiceBookingHelpers";
import { twoSentencesMax } from "../speechFormatting";
import { upsertVoiceCallState } from "../upsertVoiceCallState";
import { resolveVoiceAvailabilityWindow } from "../../appointments/resolveVoiceAvailabilityWindow";

type BookingStepLike = {
  step_key: string;
  prompt?: string | null;
  prompt_translations?: Record<string, string> | null;
  retry_prompt?: string | null;
  retry_prompt_translations?: Record<string, string> | null;
  validation_config?: {
    slot?: string;
    unavailable_prompt?: string;
    unavailable_prompt_translations?: Record<string, string> | null;
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

export type CanonicalBookingDatetimeStepParams = {
  tenantId: string;
  callSid: string;
  currentStep: BookingStepLike;
  currentIndex: number;
  currentLocale: VoiceLocale;
  callerE164: string | null;
  state: CallState;
  resolvedStepValue: string;
};

export type CanonicalBookingDatetimeStepResult =
  | {
      kind: "retry";
      state: CallState;
      prompt: string;
      context:
        | "empty_datetime"
        | "incomplete_datetime"
        | "slot_unavailable"
        | "availability_window";
    }
  | {
      kind: "resolved";
      nextState: CallState;
      resolvedValue: string;
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

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function resolveLocalizedUnavailablePrompt(input: {
  currentStep: BookingStepLike;
  currentLocale: VoiceLocale;
}): string {
  const { currentStep, currentLocale } = input;

  const locale = clean(currentLocale) || "en-US";
  const localeRoot = locale.split("-")[0]?.toLowerCase() || "";

  const translations =
    currentStep.validation_config?.unavailable_prompt_translations || null;

  const exactTranslation = clean(translations?.[locale]);
  if (exactTranslation) {
    return exactTranslation;
  }

  const rootTranslationKey = Object.keys(translations || {}).find((key) => {
    return key.toLowerCase().split("-")[0] === localeRoot;
  });

  const rootTranslation = clean(
    rootTranslationKey ? translations?.[rootTranslationKey] : ""
  );

  if (rootTranslation) {
    return rootTranslation;
  }

  const retryPrompt = resolveBookingRetryText({
    locale: currentLocale,
    retryPrompt: currentStep.retry_prompt || "",
    retryPromptTranslations: currentStep.retry_prompt_translations || null,
    fallbackPrompt: currentStep.prompt || "",
    fallbackPromptTranslations: currentStep.prompt_translations || null,
  });

  if (retryPrompt) {
    return retryPrompt;
  }

  return clean(currentStep.prompt);
}

function parseJsonStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }

  if (typeof value !== "string" || !value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.map((item) => String(item || "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export async function executeCanonicalBookingDatetimeStep(
  params: CanonicalBookingDatetimeStepParams
): Promise<CanonicalBookingDatetimeStepResult> {
  const {
    tenantId,
    callSid,
    currentStep,
    currentIndex,
    currentLocale,
    callerE164,
    state,
    resolvedStepValue,
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

    return {
      kind: "retry",
      state: nextState,
      prompt: retryPrompt,
      context: "empty_datetime",
    };
  }

  if (!serviceName) {
    return {
      kind: "resolved",
      nextState: state,
      resolvedValue: resolvedStepValue,
    };
  }

  const availabilityWindowResult = await resolveVoiceAvailabilityWindow({
    tenantId,
    serviceName,
    raw: rawDatetime,
    locale: currentLocale,
    channel: "voice",
    referenceRequestedAt: clean(
      currentBookingData.__datetime_reference_requested_at
    ),
    referenceSuggestedStarts: parseJsonStringArray(
      currentBookingData.__datetime_reference_suggested_starts
    ),
  });

  if (availabilityWindowResult.kind === "window_result") {
    const bookingDataWithWindowSuggestions = {
      ...currentBookingData,
      __datetime_reference_requested_at:
        availabilityWindowResult.referenceRequestedAtIso,
      __datetime_reference_suggested_starts: JSON.stringify(
        availabilityWindowResult.suggestedStarts
      ),
      __datetime_reference_window_key: availabilityWindowResult.windowKey,
    };

    const nextState = {
      ...state,
      bookingStepIndex: currentIndex,
      bookingData: bookingDataWithWindowSuggestions,
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
      bookingData: bookingDataWithWindowSuggestions,
    });

    return {
      kind: "retry",
      state: nextState,
      prompt: availabilityWindowResult.prompt,
      context: availabilityWindowResult.ok
        ? "availability_window"
        : "slot_unavailable",
    };
  }

  const scheduleValidation = await resolveVoiceScheduleValidation({
    tenantId,
    serviceName,
    rawDatetime,
    channel: "voice",
    referenceSuggestedStarts,
  });

  const scheduleValidationReason = String(
    (scheduleValidation as any)?.reason || ""
  ).trim();

  const isUnavailableReason =
    scheduleValidationReason === "schedule_not_available" ||
    scheduleValidationReason === "lead_time_not_met";

  const isIncompleteDatetimeReason = !isUnavailableReason;

  if (!scheduleValidation.ok) {
        const rawTopLevelSuggestedStarts = Array.isArray(
      (scheduleValidation as any).suggestedStarts
    )
      ? (scheduleValidation as any).suggestedStarts
      : [];

    const rawProviderSuggestedStarts = Array.isArray(
      (scheduleValidation as any).requestedAvailability?.suggestedStarts
    )
      ? (scheduleValidation as any).requestedAvailability.suggestedStarts
      : [];

    const referenceSuggestedStartsForState = [
      ...rawTopLevelSuggestedStarts,
      ...rawProviderSuggestedStarts,
    ]
      .map((value: unknown) => String(value || "").trim())
      .filter(Boolean);

    const requestedAtForReference =
      (scheduleValidation as any).requestedAt instanceof Date
        ? (scheduleValidation as any).requestedAt.toISOString()
        : clean(currentBookingData.__datetime_reference_requested_at);

    const bookingDataWithSuggestedStarts = {
      ...currentBookingData,
      __datetime_reference_requested_at: requestedAtForReference,
      __datetime_reference_suggested_starts: JSON.stringify(
        referenceSuggestedStartsForState
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

    const unavailablePrompt = resolveLocalizedUnavailablePrompt({
      currentStep,
      currentLocale,
    });

    const localizedRetryBase = resolveBookingRetryText({
      locale: currentLocale,
      retryPrompt: currentStep.retry_prompt || "",
      retryPromptTranslations: currentStep.retry_prompt_translations || null,
      fallbackPrompt: currentStep.prompt || "",
      fallbackPromptTranslations: currentStep.prompt_translations || null,
    });

    const promptTemplate =
      isUnavailableReason && unavailablePrompt
        ? unavailablePrompt
        : localizedRetryBase;

    const rawAvailableTimes = isUnavailableReason
      ? Array.isArray((scheduleValidation as any).availableTimes)
        ? (scheduleValidation as any).availableTimes
        : Array.isArray((scheduleValidation as any).requestedAvailability?.availableTimes)
          ? (scheduleValidation as any).requestedAvailability.availableTimes
          : []
      : [];

    const availableTimes = rawAvailableTimes
      .map((value: unknown) => String(value || "").trim())
      .filter(Boolean);

    const availableTimesText = availableTimes.join(", ");

    const rawSuggestedStarts: unknown[] = isUnavailableReason
      ? Array.isArray((scheduleValidation as any).suggestedStarts)
        ? (scheduleValidation as any).suggestedStarts
        : Array.isArray((scheduleValidation as any).requestedAvailability?.suggestedStarts)
          ? (scheduleValidation as any).requestedAvailability.suggestedStarts
          : []
      : [];

    const suggestedStarts: string[] = rawSuggestedStarts
      .map((value: unknown) => String(value || "").trim())
      .filter((value): value is string => Boolean(value));

    const formattedSuggestedTimes: string[] = suggestedStarts
      .map((iso: string) =>
        formatSuggestedStartForVoice(
          iso,
          currentLocale,
          String((scheduleValidation as any).timeZone || "").trim() || "America/New_York"
        )
      )
      .filter((value): value is string => Boolean(value))
      .slice(0, 3);

    const suggestedTimesText = formattedSuggestedTimes.join(", ");

    const hasSuggestedOrAvailableTimes = Boolean(
      suggestedTimesText || availableTimesText
    );

    const unavailablePromptNeedsSuggestedTimes =
      promptTemplate.includes("{suggested_times}") ||
      promptTemplate.includes("{available_times}");

    const safePromptTemplate =
      isUnavailableReason &&
      unavailablePromptNeedsSuggestedTimes &&
      !hasSuggestedOrAvailableTimes
        ? localizedRetryBase
        : promptTemplate;

    const retryPromptResolved = resolveBookingFlowSpeech({
      baseText: safePromptTemplate,
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

    const retryPromptFinal = retryPromptResolved;

    const retryPrompt = twoSentencesMax(
      assertNonEmptyBookingSpeech({
        text: retryPromptFinal,
        stepKey: currentStep.step_key,
        field:
          isUnavailableReason && unavailablePrompt
            ? "unavailable_prompt"
            : currentStep.retry_prompt
              ? "retry_prompt"
              : "prompt",
      })
    );

    return {
      kind: "retry",
      state: nextState,
      prompt: retryPrompt,
      context: isIncompleteDatetimeReason
        ? "incomplete_datetime"
        : "slot_unavailable",
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
    kind: "resolved",
    nextState,
    resolvedValue: rawDatetime,
  };
}

export async function handleBookingDatetimeStep(
  params: HandleBookingDatetimeStepParams
): Promise<HandleBookingDatetimeStepResult> {
  const {
    vr,
    didNumber,
    currentStep,
    currentLocale,
    voiceName,
    callSid,
    createBookingGather,
    logBotSay,
  } = params;

  const canonical = await executeCanonicalBookingDatetimeStep({
    tenantId: params.tenantId,
    callSid: params.callSid,
    currentStep: params.currentStep,
    currentIndex: params.currentIndex,
    currentLocale: params.currentLocale,
    callerE164: params.callerE164,
    state: params.state,
    resolvedStepValue: params.resolvedStepValue,
  });

  if (canonical.kind === "retry") {
    const gather = createBookingGather({
      vr,
      locale: currentLocale,
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
      context:
        canonical.context === "empty_datetime"
          ? `booking_retry_empty_datetime:${currentStep.step_key}`
          : canonical.context === "incomplete_datetime"
            ? `booking_retry_incomplete_datetime:${currentStep.step_key}`
            : `booking_retry:${currentStep.step_key}`,
    });

    return {
      handled: true,
      state: canonical.state,
      twiml: vr.toString(),
    };
  }

  return {
    handled: false,
    nextState: canonical.nextState,
    resolvedValue: canonical.resolvedValue,
  };
}