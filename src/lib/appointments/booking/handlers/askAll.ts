// src/lib/appointments/booking/handlers/askAll.ts
import { DateTime } from "luxon";

import {
  wantsToCancel,
  wantsToChangeTopic,
  parseAllInOne,
  extractDateTimeToken,
  extractDateOnlyToken,
} from "../text";

import { renderSlotsMessage, formatSlotHuman } from "../time";
import { getSlotsForDate } from "../slots";

// parseDateTimeExplicit viene de booking/time en tu flujo principal,
// pero aquí lo recibimos como dependencia para no acoplar el handler.
type ParseDateTimeExplicitFn = (
  input: string,
  timeZone: string,
  durationMin: number
) => any;

export type AskAllDeps = {
  tenantId: string;
  idioma: "es" | "en";
  userText: string;

  booking: any; // BookingCtx.booking
  timeZone: string;
  durationMin: number;
  bufferMin: number;
  hours: any | null; // HoursByWeekday | null

  parseDateTimeExplicit: ParseDateTimeExplicitFn;
};

export async function handleAskAll(deps: AskAllDeps): Promise<{
  handled: boolean;
  reply?: string;
  ctxPatch?: any;
}> {
  const {
    tenantId,
    idioma,
    userText,
    booking,
    timeZone,
    durationMin,
    bufferMin,
    hours,
    parseDateTimeExplicit,
  } = deps;

  if (wantsToChangeTopic(userText)) {
    return { handled: false, ctxPatch: { booking: { step: "idle" } } };
  }

  if (wantsToCancel(userText)) {
    return {
      handled: true,
      reply:
        idioma === "en"
          ? "Of course, no problem. I’ll stop the process for now. Whenever you’re ready, just tell me."
          : "Claro, no hay problema. Detengo todo por ahora. Cuando estés listo, solo avísame.",
      ctxPatch: {
        booking: {
          step: "idle",
          start_time: null,
          end_time: null,
          timeZone,
          name: null,
          email: null,
          purpose: null,
          date_only: null,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  const parsed = parseAllInOne(userText, timeZone, durationMin, parseDateTimeExplicit);

  // ✅ Si vino fecha/hora pero era en el pasado, dilo explícitamente
  const dtToken = extractDateTimeToken(userText);
  if (dtToken) {
    const chk: any = parseDateTimeExplicit(dtToken, timeZone, durationMin);
    if (chk?.error === "PAST_SLOT") {
      return {
        handled: true,
        reply:
          idioma === "en"
            ? "That date/time is in the past. Please send a future date and time (YYYY-MM-DD HH:mm)."
            : "Esa fecha/hora ya pasó. Envíame una fecha y hora futura (YYYY-MM-DD HH:mm).",
        ctxPatch: {
          booking: {
            step: "ask_datetime",
            timeZone,
            name: parsed?.name || booking?.name || null,
            email: parsed?.email || booking?.email || null,
            date_only: null,
          },
          booking_last_touch_at: Date.now(),
        },
      };
    }
  }

  // ✅ Caso: el usuario manda SOLO fecha (YYYY-MM-DD) + name/email pero sin hora
  const dateOnly = extractDateOnlyToken(userText);
  if (dateOnly && parsed?.name && parsed?.email && !parsed?.startISO) {
    // bloquea fecha pasada
    const dateOnlyDt = DateTime.fromFormat(dateOnly, "yyyy-MM-dd", { zone: timeZone });
    const todayStart = DateTime.now().setZone(timeZone).startOf("day");
    if (dateOnlyDt.isValid && dateOnlyDt < todayStart) {
      return {
        handled: true,
        reply:
          idioma === "en"
            ? "That date is in the past. Please send a future date (YYYY-MM-DD)."
            : "Esa fecha ya pasó. Envíame una fecha futura (YYYY-MM-DD).",
        ctxPatch: {
          booking: {
            step: "ask_datetime",
            timeZone,
            name: parsed.name,
            email: parsed.email,
            date_only: null,
            slots: [],
          },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    // Si no hay business hours, pedimos hora en HH:mm y guardamos date_only para combinar luego
    if (!hours) {
      return {
        handled: true,
        reply:
          idioma === "en"
            ? `Got it — what time works for you on ${dateOnly}? Reply with HH:mm (example: 14:00).`
            : `Perfecto — ¿a qué hora te gustaría el ${dateOnly}? Respóndeme con HH:mm (ej: 14:00).`,
        ctxPatch: {
          booking: {
            step: "ask_datetime",
            timeZone,
            name: parsed.name,
            email: parsed.email,
            date_only: dateOnly,
            slots: [],
          },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    // ✅ Hay business hours -> generamos slots para ese día
    const slots = await getSlotsForDate({
      tenantId,
      timeZone,
      dateISO: dateOnly,
      durationMin,
      bufferMin,
      hours,
    });

    return {
      handled: true,
      reply: renderSlotsMessage({ idioma, timeZone, slots }),
      ctxPatch: {
        booking: {
          step: "offer_slots",
          timeZone,
          name: parsed.name,
          email: parsed.email,
          purpose: booking?.purpose || null,
          date_only: dateOnly,
          slots,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // ✅ Si vino completo, vamos directo a confirm
  if (parsed?.name && parsed?.email && parsed?.startISO && parsed?.endISO) {
    const whenTxt = formatSlotHuman({ startISO: parsed.startISO, timeZone, idioma });
    return {
      handled: true,
      reply:
        idioma === "en"
          ? `To confirm booking for ${whenTxt}? Reply YES to confirm or NO to cancel.`
          : `Para confirmar: ${whenTxt}. Responde SI para confirmar o NO para cancelar.`,
      ctxPatch: {
        booking: {
          step: "confirm",
          timeZone,
          name: parsed.name,
          email: parsed.email,
          start_time: parsed.startISO,
          end_time: parsed.endISO,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // ✅ Fallbacks: pedir SOLO lo que falta (en orden)
  if (!parsed?.name) {
    return {
      handled: true,
      reply:
        idioma === "en"
          ? "I’m missing your first and last name (example: John Smith)."
          : "Me falta tu nombre y apellido (ej: Juan Pérez).",
      ctxPatch: {
        booking: {
          step: "ask_name",
          timeZone,
          email: parsed?.email || booking?.email || null,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  if (!parsed?.email) {
    return {
      handled: true,
      reply:
        idioma === "en"
          ? "I’m missing your email (example: name@email.com)."
          : "Me falta tu email (ej: nombre@email.com).",
      ctxPatch: {
        booking: {
          step: "ask_email",
          timeZone,
          name: parsed?.name || booking?.name || null,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // Falta fecha/hora
  return {
    handled: true,
    reply:
      idioma === "en"
        ? "I’m missing the date/time. Please use: YYYY-MM-DD HH:mm (example: 2026-01-21 14:00)."
        : "Me falta la fecha y hora. Usa: YYYY-MM-DD HH:mm (ej: 2026-01-21 14:00).",
    ctxPatch: {
      booking: {
        step: "ask_datetime",
        timeZone,
        name: parsed?.name || booking?.name || null,
        email: parsed?.email || booking?.email || null,
      },
      booking_last_touch_at: Date.now(),
    },
  };
}
