// src/lib/appointments/booking/handlers/askPurpose.ts
import { humanizeBookingReply } from "../humanizer";

export type AskPurposeDeps = {
  idioma: "es" | "en";
  userText: string;

  booking: any;
  timeZone: string;
  tenantId: string;
  canal: string;

  wantsToChangeTopic: (s: string) => boolean;
  wantsToCancel: (s: string) => boolean;
  detectPurpose: (s: string) => string | null;
};

export async function handleAskPurpose(
  deps: AskPurposeDeps
): Promise<{
  handled: boolean;
  reply?: string;
  ctxPatch?: any;
}> {
  const {
    idioma,
    userText,
    booking,
    timeZone,
    wantsToChangeTopic,
    wantsToCancel,
    detectPurpose,
  } = deps;

  const hydratedBooking = {
    ...(booking || {}),
    timeZone: (booking?.timeZone as any) || timeZone, // ✅ sticky tz
    lang: (booking?.lang as any) || idioma,           // ✅ sticky lang
  };

  const effectiveLang: "es" | "en" = hydratedBooking.lang;
  const tz = hydratedBooking.timeZone;

  // Escape: usuario cambió de tema
  if (wantsToChangeTopic(userText)) {
    return {
      handled: false,
      ctxPatch: {
        booking: { ...hydratedBooking, step: "idle", timeZone: tz, lang: effectiveLang },
      },
    };
  }

  // Cancelar proceso
  if (wantsToCancel(userText)) {
    const canonicalText =
      effectiveLang === "en"
        ? "No problem — I’ll pause scheduling for now. Whenever you’re ready, just tell me."
        : "Perfecto — pauso el agendamiento por ahora. Cuando estés listo, me dices.";

    const reply = await humanizeBookingReply({
      idioma: effectiveLang,
      intent: "cancel_booking",
      askedText: userText,
      canonicalText,
      locked: [],
    });

    return {
      handled: true,
      reply,
      ctxPatch: {
        booking: { ...hydratedBooking, step: "idle", timeZone: tz, lang: effectiveLang },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // Intentar identificar propósito
  const purpose = detectPurpose(userText);

  // Si no entendimos el propósito, aclaramos (humanizado)
  if (!purpose) {
    const canonicalText =
      effectiveLang === "en"
        ? "Got it — what are you trying to book? (class, appointment, consultation, or a call)"
        : "Entiendo — ¿qué te gustaría agendar? (clase, cita, consulta o llamada)";

    const reply = await humanizeBookingReply({
      idioma: effectiveLang,
      intent: "ask_purpose_clarify",
      askedText: userText,
      canonicalText,
      locked: [],
    });

    return {
      handled: true,
      reply,
      ctxPatch: {
        booking: { ...hydratedBooking, step: "ask_purpose", timeZone: tz, lang: effectiveLang },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // Avanza a ask_daypart (humanizado)
  const canonicalText =
    effectiveLang === "en"
      ? `Perfect — for ${purpose}, do mornings or afternoons work better?`
      : `Perfecto — para ${purpose}, ¿te funciona mejor en la mañana o en la tarde?`;

  const reply = await humanizeBookingReply({
    idioma: effectiveLang,
    intent: "ask_daypart",
    askedText: userText,
    canonicalText,
    locked: [purpose], // ✅ evita que lo “traducca” raro o lo cambie
    purpose,
  });

  return {
    handled: true,
    reply,
    ctxPatch: {
      booking: {
        ...hydratedBooking,
        step: "ask_daypart",
        timeZone: tz,
        purpose,
        lang: effectiveLang,
      },
      booking_last_touch_at: Date.now(),
    },
  };
}
