//src/lib/voice/runtime/voiceBookingSmsHelpers.ts
import type { VoiceLocale } from "../types";

export type BookingSmsPayload = {
  business_name: string;
  business_phone: string;
  service: string;
  datetime: string;
  customer_name: string;
  google_calendar_link: string;
  extra_fields?: Record<string, string>;
};

export function parseBookingSmsPayload(
  bookingData: Record<string, any> | undefined
): BookingSmsPayload | null {
  const raw = bookingData?.booking_sms_payload;

  if (!raw || typeof raw !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);

    const extraFields =
      parsed?.extra_fields &&
      typeof parsed.extra_fields === "object" &&
      !Array.isArray(parsed.extra_fields)
        ? Object.fromEntries(
            Object.entries(parsed.extra_fields)
              .map(([key, value]) => [
                String(key || "").trim(),
                String(value || "").trim(),
              ])
              .filter(([key, value]) => key && value)
          )
        : {};

    return {
      business_name: String(parsed?.business_name || "").trim(),
      business_phone: String(parsed?.business_phone || "").trim(),
      service: String(parsed?.service || "").trim(),
      datetime: String(parsed?.datetime || "").trim(),
      customer_name: String(parsed?.customer_name || "").trim(),
      google_calendar_link: String(parsed?.google_calendar_link || "").trim(),
      extra_fields: extraFields,
    };
  } catch (error) {
    console.error("[VOICE][BOOKING_SMS][PARSE_ERROR]", {
      error,
      raw,
    });
    return null;
  }
}

export function humanizeBookingFieldName(key: string): string {
  return String(key || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function buildBookingExtraFieldLines(
  extraFields?: Record<string, string>
): string[] {
  return Object.entries(extraFields || {})
    .filter(([key, value]) => String(key).trim() && String(value).trim())
    .map(([key, value]) => {
      return `${humanizeBookingFieldName(key)}: ${String(value).trim()}`;
    });
}

export function buildBookingConfirmationSmsBody(
  payload: BookingSmsPayload,
  locale: VoiceLocale
): string {
  if (locale.startsWith("es")) {
    const lines = [
      "Tu reserva quedó confirmada ✅",
      "",
      `Servicio: ${payload.service || "No especificado"}`,
      `Fecha y hora: ${payload.datetime || "No especificada"}`,
      `Cliente: ${payload.customer_name || "No especificado"}`,
      ...buildBookingExtraFieldLines(payload.extra_fields),
    ];

    if (payload.business_phone) {
      lines.push(
        "",
        `Si necesitas cambiar tu reserva contáctanos al Tel: ${payload.business_phone}.`
      );
    }

    if (payload.google_calendar_link) {
      lines.push(
        "",
        "Guarda esta cita en tu Google Calendar:",
        payload.google_calendar_link
      );
    }

    return lines.join("\n").trim();
  }

  if (locale.startsWith("pt")) {
    const lines = [
      "Sua reserva foi confirmada ✅",
      "",
      `Serviço: ${payload.service || "Não especificado"}`,
      `Data e hora: ${payload.datetime || "Não especificada"}`,
      `Cliente: ${payload.customer_name || "Não especificado"}`,
      ...buildBookingExtraFieldLines(payload.extra_fields),
    ];

    if (payload.business_phone) {
      lines.push(
        "",
        `Se precisar alterar sua reserva, entre em contato pelo Tel: ${payload.business_phone}.`
      );
    }

    if (payload.google_calendar_link) {
      lines.push(
        "",
        "Salve este compromisso no seu Google Calendar:",
        payload.google_calendar_link
      );
    }

    return lines.join("\n").trim();
  }

  const lines = [
    "Your booking is confirmed ✅",
    "",
    `Service: ${payload.service || "Not specified"}`,
    `Date and time: ${payload.datetime || "Not specified"}`,
    `Customer: ${payload.customer_name || "Not specified"}`,
    ...buildBookingExtraFieldLines(payload.extra_fields),
  ];

  if (payload.business_phone) {
    lines.push(
      "",
      `If you need to change your booking, contact us at: ${payload.business_phone}.`
    );
  }

  if (payload.google_calendar_link) {
    lines.push(
      "",
      "Save this booking to your Google Calendar:",
      payload.google_calendar_link
    );
  }

  return lines.join("\n").trim();
}