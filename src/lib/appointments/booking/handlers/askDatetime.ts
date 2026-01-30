// src/lib/appointments/booking/handlers/askDatetime.ts
import { formatSlotHuman, formatBizWindow, isWithinBusinessHours } from "../time";
import { extractTimeOnlyToken, wantsToCancel, wantsToChangeTopic } from "../text";

type AskDatetimeDeps = {
  tenantId: string;
  canal: string;
  contacto: string;
  idioma: "es" | "en";
  userText: string;

  booking: any; // BookingCtx.booking
  timeZone: string;
  durationMin: number;
  hours: any | null;

  // Inyecta el parser (para testear y evitar imports pesados en bookingFlow)
  parseDateTimeExplicit: (text: string, timeZone: string, durationMin: number) => any;
};

export async function handleAskDatetime(deps: AskDatetimeDeps): Promise<{
  handled: boolean;
  reply?: string;
  ctxPatch?: any;
}> {
  const {
    idioma,
    userText,
    booking,
    timeZone,
    durationMin,
    hours,
    parseDateTimeExplicit,
  } = deps;

    const hydratedBooking = {
    ...booking,
    timeZone: booking?.timeZone || timeZone,
    lang: booking?.lang || idioma, // ✅ sticky
  };

  const effectiveLang: "es" | "en" = (hydratedBooking.lang as any) || idioma;

  const tz = hydratedBooking.timeZone;
  const b: any = hydratedBooking;
  const dateCtx = b?.date_only || b?.last_offered_date || null;

  // Escape: cambió de tema
  if (wantsToChangeTopic(userText)) {
    return { handled: false, ctxPatch: { booking: { ...hydratedBooking, step: "idle" } } };
  }

  // Cancelar
  if (wantsToCancel(userText)) {
    return {
      handled: true,
      reply:
        effectiveLang === "en"
          ? "Of course, no problem. I’ll stop the process for now. Whenever you’re ready, just tell me."
          : "Claro, no hay problema. Detengo todo por ahora. Cuando estés listo, solo avísame.",
      ctxPatch: {
        booking: { ...hydratedBooking, step: "idle" },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // 1) Caso: solo hora (HH:mm o flexible 5pm / a las 5)
  const hhmmOnly = String(userText || "").trim().match(/^(\d{1,2}:\d{2})$/);
  const flex = extractTimeOnlyToken(userText);
  const wantsOnlyTime = !!(hhmmOnly || flex);

  // Si manda solo hora pero NO hay fecha contexto, no adivines
  if (wantsOnlyTime && !dateCtx) {
    return {
      handled: true,
      reply:
        effectiveLang === "en"
          ? "What day would you like to book? Please send a date (YYYY-MM-DD)."
          : "¿Para qué día quieres agendar? Envíame una fecha (YYYY-MM-DD).",
      ctxPatch: {
        booking: { ...hydratedBooking, step: "ask_datetime", timeZone },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // Si hay dateCtx + hora -> parsea `${dateCtx} ${hhmm}`
  if (dateCtx && wantsOnlyTime) {
    const hhmmVal = hhmmOnly ? hhmmOnly[1].padStart(5, "0") : String(flex);
    const parsed2: any = parseDateTimeExplicit(`${dateCtx} ${hhmmVal}`, tz, durationMin);

    if (!parsed2) {
      return {
        handled: true,
        reply:
          effectiveLang === "en"
            ? "I couldn’t read that time. Please use HH:mm (example: 14:00)."
            : "No pude leer esa hora. Usa HH:mm (ej: 14:00).",
        ctxPatch: {
          booking: { ...hydratedBooking, step: "ask_datetime", timeZone },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    if (parsed2?.error === "PAST_SLOT") {
      return {
        handled: true,
        reply:
          effectiveLang === "en"
            ? "That time is in the past. Please send a future time."
            : "Esa hora ya pasó. Envíame una hora futura.",
        ctxPatch: {
          booking: { ...hydratedBooking, step: "ask_datetime", timeZone },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    // Business hours (si aplica)
    if (hours && parsed2?.startISO && parsed2?.endISO) {
      const check = isWithinBusinessHours({
        hours,
        startISO: parsed2.startISO,
        endISO: parsed2.endISO,
        timeZone,
      });

      if (!check.ok) {
        if (check.reason === "closed") {
          return {
            handled: true,
            reply:
              effectiveLang === "en"
                ? "We’re closed that day. Please choose another date."
                : "Ese día estamos cerrados. Envíame otra fecha.",
            ctxPatch: {
              booking: { ...hydratedBooking, step: "ask_datetime", timeZone },
              booking_last_touch_at: Date.now(),
            },
          };
        }

        if (check.reason === "outside" && (check as any).bizStart && (check as any).bizEnd) {
          const windowTxt = formatBizWindow(
            effectiveLang,
            (check as any).bizStart,
            (check as any).bizEnd
          );
          return {
            handled: true,
            reply:
              effectiveLang === "en"
                ? `That time is outside business hours (${windowTxt}). Please send a time within that range.`
                : `Esa hora está fuera del horario (${windowTxt}). Envíame una hora dentro de ese rango.`,
            ctxPatch: {
              booking: { ...hydratedBooking, step: "ask_datetime", timeZone },
              booking_last_touch_at: Date.now(),
            },
          };
        }
      }
    }

    const whenTxt = formatSlotHuman({ startISO: parsed2.startISO!, timeZone, idioma: effectiveLang });

    return {
      handled: true,
      reply:
        effectiveLang === "en"
          ? `To confirm booking for ${whenTxt}? Reply YES to confirm or NO to cancel.`
          : `Para confirmar: ${whenTxt}. Responde SI para confirmar o NO para cancelar.`,
      ctxPatch: {
        booking: {
          ...hydratedBooking,
          step: "confirm",
          start_time: parsed2.startISO,
          end_time: parsed2.endISO,
          timeZone,
          date_only: null,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // 2) Caso: fecha/hora completa en un mensaje
  const parsed: any = parseDateTimeExplicit(userText, timeZone, durationMin);

  if (!parsed) {
    return {
      handled: true,
      reply:
        effectiveLang === "en"
          ? "I couldn’t read that. Please use: YYYY-MM-DD HH:mm (example: 2026-01-17 15:00)."
          : "No pude leer esa fecha/hora. Usa: YYYY-MM-DD HH:mm (ej: 2026-01-17 15:00).",
      ctxPatch: {
        booking: { ...hydratedBooking, step: "ask_datetime", timeZone },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  if (parsed?.error === "PAST_SLOT") {
    return {
      handled: true,
      reply:
        effectiveLang === "en"
          ? "That date/time is in the past. Please send a future date and time (YYYY-MM-DD HH:mm)."
          : "Esa fecha/hora ya pasó. Envíame una fecha y hora futura (YYYY-MM-DD HH:mm).",
      ctxPatch: {
        booking: { ...hydratedBooking, step: "ask_datetime", timeZone },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // Business hours (si aplica)
  if (hours && parsed?.startISO && parsed?.endISO) {
    const check = isWithinBusinessHours({
      hours,
      startISO: parsed.startISO,
      endISO: parsed.endISO,
      timeZone,
    });

    if (!check.ok) {
      if (check.reason === "closed") {
        return {
          handled: true,
          reply:
            effectiveLang === "en"
              ? "We’re closed that day. Please choose another date."
              : "Ese día estamos cerrados. Envíame otra fecha.",
          ctxPatch: {
            booking: { ...hydratedBooking, step: "ask_datetime", timeZone },
            booking_last_touch_at: Date.now(),
          },
        };
      }

      if (check.reason === "outside" && (check as any).bizStart && (check as any).bizEnd) {
        const windowTxt = formatBizWindow(effectiveLang, (check as any).bizStart, (check as any).bizEnd);
        return {
          handled: true,
          reply:
            effectiveLang === "en"
              ? `That time is outside business hours (${windowTxt}). Please send a time within that range.`
              : `Esa hora está fuera del horario (${windowTxt}). Envíame una hora dentro de ese rango.`,
          ctxPatch: {
            booking: { ...hydratedBooking, step: "ask_datetime", timeZone },
            booking_last_touch_at: Date.now(),
          },
        };
      }
    }
  }

  const whenTxt = formatSlotHuman({ startISO: parsed.startISO!, timeZone, idioma: effectiveLang });

  return {
    handled: true,
    reply:
      effectiveLang === "en"
        ? `To confirm booking for ${whenTxt}? Reply YES to confirm or NO to cancel.`
        : `Para confirmar: ${whenTxt}. Responde SI para confirmar o NO para cancelar.`,
    ctxPatch: {
      booking: {
        ...hydratedBooking,
        step: "confirm",
        start_time: parsed.startISO,
        end_time: parsed.endISO,
        timeZone,
      },
      booking_last_touch_at: Date.now(),
    },
  };
}
