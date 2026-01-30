// src/lib/appointments/booking/handlers/start.ts
import { DateTime } from "luxon";
import { buildDateTimeFromText, extractDateOnlyToken } from "../text";
import type { HoursByWeekday } from "../types";
import { weekdayKey, parseHHmm } from "../time";


export type StartBookingDeps = {
  idioma: "es" | "en";
  userText: string;
  timeZone: string;

  wantsBooking: boolean;
  detectPurpose: (s: string) => string | null;

  durationMin: number;

  // ✅ opcionales (para no romper callers)
  minLeadMinutes?: number;
  hours?: HoursByWeekday | null;
  booking?: any; // ✅ ADD
};

export function handleStartBooking(deps: StartBookingDeps): {
  handled: boolean;
  reply?: string;
  ctxPatch?: any;
} {
  const { idioma, userText, timeZone, wantsBooking, detectPurpose, durationMin, minLeadMinutes, hours, booking } = deps;
  const hydratedBooking = {
    ...(booking || {}),
    timeZone: (booking?.timeZone as any) || timeZone, // ✅ sticky tz
    lang: (booking?.lang as any) || idioma,           // ✅ sticky lang
  };

  const effectiveLang: "es" | "en" = hydratedBooking.lang;
  const tz = hydratedBooking.timeZone;

  if (!wantsBooking) return { handled: false };

  // ✅ NUEVO: si el usuario ya dijo día+hora ("lunes a las 3") -> confirm directo
  // Vamos a validar usando:
  // - minLeadMinutes (por tenant)
  // - businessHours (por tenant) según el weekday del dateISO detectado
  const dateISO = extractDateOnlyToken(userText, tz);

  let businessHours: { start: string; end: string } | undefined = undefined;
  if (dateISO && hours) {
    const day = DateTime.fromFormat(dateISO, "yyyy-MM-dd", { zone: tz });
    if (day.isValid) {
      const key = weekdayKey(day);
      const dayHours = hours[key];
      if (dayHours?.start && dayHours?.end && parseHHmm(dayHours.start) && parseHHmm(dayHours.end)) {
        businessHours = { start: dayHours.start, end: dayHours.end };
      }
    }
  }

  const dt = buildDateTimeFromText(userText, tz, durationMin, {
    minLeadMinutes,
    businessHours,
  });

  // Si buildDateTimeFromText devolvió error, responde algo usable
  if (dt && "error" in dt) {
    if (dt.error === "PAST_SLOT") {
      return {
        handled: true,
        reply:
          effectiveLang === "en"
            ? "That time is too soon or already passed. What other time works for you?"
            : "Ese horario está muy pronto o ya pasó. ¿Qué otra hora te funciona?",
        ctxPatch: {
          booking: { ...(booking || {}), step: "ask_datetime", timeZone: tz, lang: effectiveLang },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    // OUTSIDE_HOURS
    return {
      handled: true,
      reply:
        effectiveLang === "en"
          ? "That time is outside our business hours. What time within business hours works for you?"
          : "Ese horario está fuera del horario del negocio. ¿Qué hora dentro del horario te funciona?",
      ctxPatch: {
        booking: { ...(booking || {}), step: "ask_datetime", timeZone: tz, lang: effectiveLang },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  if (dt) {
    const human =
      effectiveLang === "en"
        ? DateTime.fromISO(dt.startISO).setZone(tz).toFormat("cccc, LLL d 'at' h:mm a")
        : DateTime.fromISO(dt.startISO).setZone(tz).toFormat("cccc d 'de' LLL 'a las' h:mm a");

    return {
      handled: true,
      reply:
        effectiveLang === "en"
          ? `Perfect — I have ${human}. Confirm?`
          : `Perfecto — tengo ${human}. ¿Confirmas?`,
      ctxPatch: {
        booking: {
          ...(booking || {}),
          step: "confirm",
          timeZone: tz,
          lang: effectiveLang,
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
        effectiveLang === "en"
          ? "Sure! What would you like to schedule — an appointment, a consultation, or a call?"
          : "¡Claro! ¿Qué te gustaría agendar? Una cita, una consulta o una llamada.",
      ctxPatch: {
        booking: { ...(booking || {}), step: "ask_purpose", timeZone: tz, lang: effectiveLang },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // 2) Con propósito -> pregunta daypart
  return {
    handled: true,
    reply:
      effectiveLang === "en"
        ? "Sure, I can help you schedule it. Does morning or afternoon work better for you?"
        : "Claro, puedo ayudarte a agendar. ¿Te funciona más en la mañana o en la tarde?",
    ctxPatch: {
      booking: { ...(booking || {}), step: "ask_daypart", timeZone: tz, purpose, lang: effectiveLang },
      booking_last_touch_at: Date.now(),
    },
  };
}
