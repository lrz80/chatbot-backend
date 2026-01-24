// src/lib/appointments/booking/handlers/start.ts
export type StartBookingDeps = {
  idioma: "es" | "en";
  userText: string;
  timeZone: string;

  wantsBooking: boolean;
  detectPurpose: (s: string) => string | null;
};

export function handleStartBooking(deps: StartBookingDeps): {
  handled: boolean;
  reply?: string;
  ctxPatch?: any;
} {
  const { idioma, userText, timeZone, wantsBooking, detectPurpose } = deps;

  if (!wantsBooking) return { handled: false };

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
