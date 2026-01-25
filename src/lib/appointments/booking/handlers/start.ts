// src/lib/appointments/booking/handlers/start.ts
import { DateTime } from "luxon";
import { buildDateTimeFromText } from "../text";

export type StartBookingDeps = {
  idioma: "es" | "en";
  userText: string;
  timeZone: string;

  wantsBooking: boolean;
  detectPurpose: (s: string) => string | null;

  durationMin: number; // ✅ NUEVO
};

export function handleStartBooking(deps: StartBookingDeps): {
  handled: boolean;
  reply?: string;
  ctxPatch?: any;
} {
  const { idioma, userText, timeZone, wantsBooking, detectPurpose, durationMin } = deps;

  if (!wantsBooking) return { handled: false };

  // ✅ NUEVO: si el usuario ya dijo día+hora ("lunes a las 3") -> confirm directo
  const dt = buildDateTimeFromText(userText, timeZone, durationMin);
  if (dt) {
    const human =
      idioma === "en"
        ? DateTime.fromISO(dt.startISO).setZone(timeZone).toFormat("cccc, LLL d 'at' h:mm a")
        : DateTime.fromISO(dt.startISO).setZone(timeZone).toFormat("cccc d 'de' LLL 'a las' h:mm a");

    return {
      handled: true,
      reply:
        idioma === "en"
          ? `Perfect — I have ${human}. Confirm?`
          : `Perfecto — tengo ${human}. ¿Confirmas?`,
      ctxPatch: {
        booking: {
          step: "confirm",
          timeZone,
          picked_start: dt.startISO,
          picked_end: dt.endISO,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  const purpose = detectPurpose(userText);

  // 1) Sin propósito -> pregunta propósito
  if (!purpose) {
    return {
      handled: true,
      reply:
        idioma === "en"
          ? "Sure! What would you like to schedule — an appointment, a consultation, or a call?"
          : "¡Claro! ¿Qué te gustaría agendar? Una cita, una consulta o una llamada.",
      ctxPatch: {
        booking: { step: "ask_purpose", timeZone },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // 2) Con propósito -> pregunta daypart
  return {
    handled: true,
    reply:
      idioma === "en"
        ? "Sure, I can help you schedule it. Does morning or afternoon work better for you?"
        : "Claro, puedo ayudarte a agendar. ¿Te funciona más en la mañana o en la tarde?",
    ctxPatch: {
      booking: { step: "ask_daypart", timeZone, purpose },
      booking_last_touch_at: Date.now(),
    },
  };
}
