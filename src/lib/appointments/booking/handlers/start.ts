// src/lib/appointments/booking/handlers/start.ts
import { DateTime } from "luxon";
import { buildDateTimeFromText, extractDateOnlyToken, extractTimeOnlyToken, extractTimeConstraint } from "../text";
import type { HoursByWeekday } from "../types";
import { weekdayKey, parseHHmm } from "../time";
import { getSlotsForDateWindow } from "../slots";
import { renderSlotsMessage } from "../time";


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

  tenantId?: string;
  bufferMin?: number;
  getSlotsForDateWindow?: typeof getSlotsForDateWindow;
};

export async function handleStartBooking(deps: StartBookingDeps): Promise<{
  handled: boolean;
  reply?: string;
  ctxPatch?: any;
}> {
  const { idioma, userText, timeZone, wantsBooking, detectPurpose, durationMin, minLeadMinutes, hours, booking } = deps;
  const hydratedBooking = {
    ...(booking || {}),
    timeZone: (booking?.timeZone as any) || timeZone, // ✅ sticky tz
    lang: (booking?.lang as any) || idioma,           // ✅ sticky lang
  };

  const effectiveLang: "es" | "en" = hydratedBooking.lang;
  const tz = hydratedBooking.timeZone;

  if (!wantsBooking) return { handled: false };

  const resetPersonal = {
    name: null,
    email: null,
    phone: null,   // WA no lo necesita, Meta lo llenas luego
  };

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

    // ✅ Si el usuario dijo fecha + hora, valida disponibilidad real antes de "confirm"
  const dateISO2 = extractDateOnlyToken(userText, tz);

  // intenta sacar HH:mm del texto (usa tu extractor que ya tienes en otros handlers)
  let hhmm =
    extractTimeOnlyToken(userText) ||
    (() => {
      const c: any = extractTimeConstraint(userText);
      return typeof c?.hhmm === "string" ? c.hhmm : null;
    })();

  if (dateISO2 && hhmm && hours && deps.getSlotsForDateWindow && deps.tenantId && typeof deps.bufferMin === "number") {
    const h = Number(hhmm.slice(0, 2));
    const m = Number(hhmm.slice(3, 5));

    const base = DateTime.fromFormat(dateISO2, "yyyy-MM-dd", { zone: tz })
      .set({ hour: h, minute: m, second: 0, millisecond: 0 });

    const windowStartHHmm = base.minus({ hours: 2 }).toFormat("HH:mm");
    const windowEndHHmm = base.plus({ hours: 3 }).toFormat("HH:mm");

    const windowSlots = await deps.getSlotsForDateWindow({
      tenantId: deps.tenantId,
      timeZone: tz,
      dateISO: dateISO2,
      durationMin,
      bufferMin: deps.bufferMin,
      hours,
      windowStartHHmm,
      windowEndHHmm,
      minLeadMinutes: deps.minLeadMinutes || 0,
    });

    if (windowSlots?.length) {
      const exact = windowSlots.find((s) => {
        const start = DateTime.fromISO(s.startISO, { zone: tz }).toFormat("HH:mm");
        return start === hhmm;
      });

      // ✅ Exacto disponible -> confirm directo (igual que askDaypart)
      if (exact) {
        const human =
          effectiveLang === "en"
            ? DateTime.fromISO(exact.startISO, { zone: tz }).setLocale("en").toFormat("cccc, LLL d 'at' h:mm a")
            : DateTime.fromISO(exact.startISO, { zone: tz }).setLocale("es").toFormat("cccc d 'de' LLL 'a las' h:mm a");

        return {
          handled: true,
          reply: effectiveLang === "en"
            ? `Perfect — I have ${human}. Confirm?`
            : `Perfecto — tengo ${human}. ¿Confirmas?`,
          ctxPatch: {
            booking: {
              ...(hydratedBooking || {}),
              step: "confirm",
              timeZone: tz,
              lang: effectiveLang,
              picked_start: exact.startISO,
              picked_end: exact.endISO,
              start_time: exact.startISO,
              end_time: exact.endISO,
              date_only: dateISO2,
              last_offered_date: dateISO2,
              slots: [],
            },
            booking_last_touch_at: Date.now(),
          },
        };
      }

      // ❌ No hay exacto -> ofrecer cercanos (top 5)
      const take = [...windowSlots]
        .sort((a, b) => {
          const am = DateTime.fromISO(a.startISO, { zone: tz }).toMillis();
          const bm = DateTime.fromISO(b.startISO, { zone: tz }).toMillis();
          const target = base.toMillis();
          return Math.abs(am - target) - Math.abs(bm - target);
        })
        .slice(0, 3);

      return {
        handled: true,
        reply:
          effectiveLang === "en"
            ? `I don’t have that exact time. Here are the closest options:\n\n` + renderSlotsMessage({ idioma: effectiveLang, timeZone: tz, slots: take, style: "closest" })
            : `No tengo esa hora exacta. Estas son las opciones más cercanas:\n\n` + renderSlotsMessage({ idioma: effectiveLang, timeZone: tz, slots: take, style: "closest" }),
        ctxPatch: {
          booking: {
            ...(hydratedBooking || {}),
            ...resetPersonal,
            step: "offer_slots",
            timeZone: tz,
            lang: effectiveLang,
            date_only: dateISO2,
            last_offered_date: dateISO2,
            slots: take,
          },
          booking_last_touch_at: Date.now(),
        },
      };
    }
  }

  if (dt) {
    const d = DateTime.fromISO(dt.startISO, { zone: tz }).setLocale(
      effectiveLang === "en" ? "en" : "es"
    );

    const human =
      effectiveLang === "en"
        ? d.toFormat("cccc, LLL d 'at' h:mm a")
        : d.toFormat("cccc d 'de' LLL 'a las' h:mm a");

    return {
      handled: true,
      reply:
        effectiveLang === "en"
          ? `Perfect — I have ${human}. Confirm?`
          : `Perfecto — tengo ${human}. ¿Confirmas?`,
      ctxPatch: {
        booking: {
          ...(hydratedBooking || {}),
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
