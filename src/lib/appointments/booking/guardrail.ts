// backend/src/lib/appointments/booking/guardrail.ts
import type { LangCode } from "../../i18n/lang";
import { hasExplicitDateTime } from "./parsers/dateTimeParsers";
import {
  hasAppointmentContext,
  isDirectBookingRequest,
  wantsSpecificTime,
} from "./signals/bookingSignals";

export type BookingGuardrailSignalsOpts = {
  userText: string;
  detectedIntent?: string | null;
};

const BOOKING_INTENT_KEYS = new Set([
  "booking",
  "book_appointment",
  "appointment",
  "availability",
  "schedule",
  "schedule_appointment",
  "agendar_cita",
  "disponibilidad",
]);

export function hasBookingSignal(opts: BookingGuardrailSignalsOpts): boolean {
  const { userText, detectedIntent } = opts;

  const normalizedIntent = String(detectedIntent || "").trim().toLowerCase();

  const signal =
    hasExplicitDateTime(userText) ||
    isDirectBookingRequest(userText) ||
    hasAppointmentContext(userText) ||
    wantsSpecificTime(userText) ||
    BOOKING_INTENT_KEYS.has(normalizedIntent);

  return Boolean(signal);
}

export type BookingGuardrailRunOpts = {
  bookingEnabled: boolean;
  bookingLink?: string | null;

  tenantId: string;
  canal: "whatsapp" | "facebook" | "instagram" | string;
  contacto: string;
  idioma: LangCode;
  userText: string;
  ctx: any;
  messageId?: string | null;

  detectedIntent?: string | null;

  bookingFlow: (opts: any) => Promise<{ handled: boolean; reply?: string; ctxPatch?: any }>;
};

export async function runBookingGuardrail(
  opts: BookingGuardrailRunOpts
): Promise<{
  hit: boolean;
  result?: { handled: boolean; reply?: string; ctxPatch?: any };
}> {
  const {
    bookingEnabled,
    bookingFlow,
    userText,
    detectedIntent,
  } = opts;

  if (!bookingEnabled) return { hit: false };

  if (!hasBookingSignal({ userText, detectedIntent })) {
    return { hit: false };
  }

  const bk = await bookingFlow({
    tenantId: opts.tenantId,
    canal: opts.canal,
    contacto: opts.contacto,
    idioma: opts.idioma,
    userText: opts.userText,
    ctx: opts.ctx,
    bookingLink: opts.bookingLink || null,
    messageId: opts.messageId || null,
  });

  if (bk?.handled) {
    return { hit: true, result: bk };
  }

  return { hit: false, result: bk };
}