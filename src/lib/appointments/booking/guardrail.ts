// backend/src/lib/appointments/booking/guardrail.ts
import {
  hasAppointmentContext,
  hasExplicitDateTime,
  isDirectBookingRequest,
  wantsSpecificTime,
} from "./text";

export type BookingGuardrailSignalsOpts = {
  userText: string;
  detectedIntent?: string | null;
  // si quieres, luego puedes inyectar "bookingTerms" o flags por tenant
};

export function hasBookingSignal(opts: BookingGuardrailSignalsOpts): boolean {
  const { userText, detectedIntent } = opts;

  // Señales fuertes / conservadoras
  const signal =
    hasExplicitDateTime(userText) ||
    isDirectBookingRequest(userText) ||
    hasAppointmentContext(userText) ||
    wantsSpecificTime(userText) ||
    detectedIntent === "disponibilidad" ||
    detectedIntent === "agendar_cita";

  return !!signal;
}

export type BookingGuardrailRunOpts = {
  // gating
  bookingEnabled: boolean;           // toggle ON/OFF (channel_settings.google_calendar_enabled)
  bookingLink?: string | null;       // LINK_RESERVA si existe
  // turn context
  tenantId: string;
  canal: "whatsapp" | "facebook" | "instagram" | string;
  contacto: string;
  idioma: "es" | "en";
  userText: string;
  ctx: any;
  messageId?: string | null;

  // señales externas (opcional)
  detectedIntent?: string | null;

  // dependency injection (para reusar en otros routes sin importar directo)
  bookingFlow: (opts: any) => Promise<{ handled: boolean; reply?: string; ctxPatch?: any }>;
};

export async function runBookingGuardrail(opts: BookingGuardrailRunOpts): Promise<{
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

  // si NO hay señal de booking, no corras nada
  if (!hasBookingSignal({ userText, detectedIntent })) return { hit: false };

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

  // aunque handled=false, igual devolvemos result por si quieres aplicar ctxPatch afuera
  if (bk?.handled) return { hit: true, result: bk };

  return { hit: false, result: bk };
}
