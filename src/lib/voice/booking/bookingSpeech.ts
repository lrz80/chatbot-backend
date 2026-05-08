//src/lib/voice/booking/bookingSpeech.ts
import { twiml } from "twilio";
import { VoiceLocale } from "../types";

export function buildExtraBookingFields(
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
    "__datetime_reference_suggested_starts",
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

export function formatSuggestedStartForVoice(
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

export function buildBusyAlternativesPrompt(params: {
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

export function assertNonEmptyBookingSpeech(input: {
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

export function resolveBookingSpeechFast(params: {
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

export function createBookingGather(params: {
  vr: twiml.VoiceResponse;
  locale: VoiceLocale;
  isPhoneStep?: boolean;
  isConfirmationStep?: boolean;
}) {
  const input =
    params.isPhoneStep || params.isConfirmationStep
      ? (["speech", "dtmf"] as const)
      : (["speech"] as const);

  return params.vr.gather({
    input: input as any,
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