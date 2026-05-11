//src/lib/voice/booking/bookingSpeech.ts
import { twiml } from "twilio";
import { VoiceLocale } from "../types";

type BookingFlowStepLike = {
  step_key?: string | null;
  expected_type?: string | null;
  validation_config?: Record<string, any> | null;
};

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
    "__booking_busy_retry",
    "__booking_busy_suggested_starts",
    "__last_booking_error",
    "appointment_type",
    "location_detail",
    "subject_detail",
    "datetime_iso",
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

function normalizeHintToken(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeHintToken(item));
  }

  if (!value || typeof value === "boolean") {
    return [];
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;

    return [
      ...normalizeHintToken(obj.label),
      ...normalizeHintToken(obj.value),
      ...normalizeHintToken(obj.name),
      ...normalizeHintToken(obj.title),
      ...normalizeHintToken(obj.synonyms),
      ...normalizeHintToken(obj.aliases),
      ...normalizeHintToken(obj.keywords),
      ...normalizeHintToken(obj.phrases),
    ];
  }

  const clean = String(value).trim();
  if (!clean) return [];

  return [clean];
}

function dedupeHintTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const token of tokens) {
    const normalized = token.toLowerCase().trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(token.trim());
  }

  return result;
}

export function buildBookingStepSpeechHints(
  step?: BookingFlowStepLike | null
): string | undefined {
  const validationConfig =
    step?.validation_config && typeof step.validation_config === "object"
      ? step.validation_config
      : null;

  if (!validationConfig) {
    return undefined;
  }

  const explicitHintTokens = dedupeHintTokens([
    ...normalizeHintToken(validationConfig.speech_hints),
    ...normalizeHintToken(validationConfig.hints),
  ]);

  if (explicitHintTokens.length > 0) {
    return explicitHintTokens.join(", ");
  }

  const optionHintTokens = dedupeHintTokens(
    normalizeHintToken(validationConfig.options)
  );

  if (optionHintTokens.length > 0) {
    return optionHintTokens.join(", ");
  }

  return undefined;
}

export function createBookingGather(params: {
  vr: twiml.VoiceResponse;
  locale: VoiceLocale;
  step?: BookingFlowStepLike | null;
  isPhoneStep?: boolean;
  isConfirmationStep?: boolean;
  hints?: string;
  timeout?: number;
  bargeIn?: boolean;
}) {
  const expectedType =
    typeof params.step?.expected_type === "string"
      ? params.step.expected_type.trim()
      : params.isPhoneStep
      ? "phone"
      : params.isConfirmationStep
      ? "confirmation"
      : "";

  const input =
    expectedType === "phone" || expectedType === "confirmation"
      ? (["speech", "dtmf"] as const)
      : (["speech"] as const);

  const numDigits =
    expectedType === "phone" ? 15 : expectedType === "confirmation" ? 1 : undefined;

  const resolvedHints =
    (params.hints || "").trim() || buildBookingStepSpeechHints(params.step);

  return params.vr.gather({
    input: input as any,
    ...(typeof numDigits === "number" ? { numDigits } : {}),
    action: "/webhook/voice-response",
    method: "POST",
    language: params.locale as any,
    speechModel: "phone_call",
    speechTimeout: "auto",
    timeout:
      typeof params.timeout === "number"
        ? params.timeout
        : expectedType === "phone"
        ? 10
        : 5,
    actionOnEmptyResult: true,
    bargeIn: typeof params.bargeIn === "boolean" ? params.bargeIn : false,
    ...(resolvedHints ? { hints: resolvedHints } : {}),
  });
}