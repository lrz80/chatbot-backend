// src/lib/appointments/booking/handlers/askDaypart.ts
import { DateTime } from "luxon";
import {
  wantsToCancel,
  wantsToChangeTopic,
  detectDaypart,
  buildAskAllMessage,
} from "../text";
import { renderSlotsMessage } from "../time";
import { getNextSlotsByDaypart } from "../slots";
import { extractDateOnlyToken } from "../text";
import { getSlotsForDateOnly } from "../slots/getSlotsForDateOnly";
import { extractTimeOnlyToken, extractTimeConstraint } from "../text";
import { getSlotsForDateWindow, getSlotsForDate } from "../slots";


export type AskDaypartDeps = {
  tenantId: string;
  idioma: "es" | "en";
  userText: string;

  booking: any; // BookingCtx.booking
  timeZone: string;
  durationMin: number;
  bufferMin: number;
  hours: any | null; // HoursByWeekday | null
};

function inferDaypartFromHHMM(hhmm: string): "morning" | "afternoon" {
  const h = Number(hhmm.slice(0, 2));
  return h >= 12 ? "afternoon" : "morning";
}

export async function handleAskDaypart(deps: AskDaypartDeps): Promise<{
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
  } = deps;

  if (wantsToChangeTopic(userText)) {
    return { handled: false, ctxPatch: { booking: { step: "idle" } } };
  }

  if (wantsToCancel(userText)) {
    return {
      handled: true,
      reply:
        idioma === "en"
          ? "No worries, whenever you’re ready to schedule, I’ll be here to help."
          : "No hay problema, cuando necesites agendar estaré aquí para ayudarte.",
      ctxPatch: {
        booking: { step: "idle" },
        booking_last_touch_at: Date.now(),
      },
    };
  }

    // ✅ Si el usuario menciona una fecha ("para el 25", "martes", "mañana", etc.)
  // en vez de daypart, debemos continuar el flujo ofreciendo slots para esa fecha.
  const dateOnly = extractDateOnlyToken(userText, timeZone);

  if (dateOnly) {
    // Si no hay horario configurado: pedir todo manualmente, pero guardando date_only
    if (!hours) {
      return {
        handled: true,
        reply: buildAskAllMessage(idioma, booking?.purpose || null),
        ctxPatch: {
          booking: {
            ...booking,
            step: "ask_all",
            timeZone,
            date_only: dateOnly,
          },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    // Si hay horario: ofrecer slots de ESE día (sin preguntar mañana/tarde)
    const slotsForDay = await getSlotsForDateOnly({
      tenantId,
      timeZone,
      durationMin,
      bufferMin,
      hours,
      dateOnly, // yyyy-MM-dd
    });

    if (!slotsForDay?.length) {
      return {
        handled: true,
        reply:
          idioma === "en"
            ? "I don’t have openings that day. Would morning or afternoon on another day work for you?"
            : "Ese día no tengo disponibilidad. ¿Te funciona más en la mañana o en la tarde en otro día?",
        ctxPatch: {
          booking: { ...booking, step: "ask_daypart", timeZone },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    return {
      handled: true,
      reply: renderSlotsMessage({ idioma, timeZone, slots: slotsForDay }),
      ctxPatch: {
        booking: {
          step: "offer_slots",
          timeZone,
          purpose: booking?.purpose || null,
          daypart: null,
          slots: slotsForDay,
          date_only: dateOnly,
          last_offered_date: dateOnly,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // ✅ Si el usuario responde con una HORA ("3pm", "15:00", "a las 3")
  // en vez de "mañana/tarde", inferimos daypart y buscamos una ventana real alrededor de esa hora.
  const hhmm =
    extractTimeOnlyToken(userText) ||
    (() => {
      const c: any = extractTimeConstraint(userText);
      return typeof c?.hhmm === "string" ? c.hhmm : null;
    })();

  if (hhmm) {
    // Si no hay horario configurado, pasamos a ask_all y guardamos lo que podamos
    if (!hours) {
      return {
        handled: true,
        reply: buildAskAllMessage(idioma, booking?.purpose || null),
        ctxPatch: {
          booking: {
            ...booking,
            step: "ask_all",
            timeZone,
            daypart: inferDaypartFromHHMM(hhmm),
          },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    // Determina fecha contexto: si ya hay date_only úsala; si no, usa hoy (o mañana si ya es tarde)
    const tz = timeZone;
    const ctxDate =
      booking?.date_only ||
      booking?.last_offered_date ||
      DateTime.now().setZone(tz).toFormat("yyyy-MM-dd");

    const h = Number(hhmm.slice(0, 2));
    const m = Number(hhmm.slice(3, 5));

    const base = DateTime.fromFormat(ctxDate, "yyyy-MM-dd", { zone: tz })
      .set({ hour: h, minute: m, second: 0, millisecond: 0 });

    const windowStartHHmm = base.minus({ hours: 2 }).toFormat("HH:mm");
    const windowEndHHmm = base.plus({ hours: 3 }).toFormat("HH:mm");

    const windowSlots = await getSlotsForDateWindow({
      tenantId,
      timeZone: tz,
      dateISO: ctxDate,
      durationMin,
      bufferMin,
      hours,
      windowStartHHmm,
      windowEndHHmm,
    });

    if (windowSlots?.length) {
      const take = [...windowSlots]
        .sort((a, b) => a.startISO.localeCompare(b.startISO))
        .slice(0, 5);

      return {
        handled: true,
        reply: renderSlotsMessage({ idioma, timeZone: tz, slots: take }),
        ctxPatch: {
          booking: {
            step: "offer_slots",
            timeZone: tz,
            purpose: booking?.purpose || null,
            daypart: inferDaypartFromHHMM(hhmm),
            slots: take,
            date_only: ctxDate,
            last_offered_date: ctxDate,
          },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    // Fallback: si no hay en ventana, ofrece el día completo
    const allDaySlots = await getSlotsForDate({
      tenantId,
      timeZone: tz,
      dateISO: ctxDate,
      durationMin,
      bufferMin,
      hours,
    });

    if (allDaySlots?.length) {
      const take = [...allDaySlots]
        .sort((a, b) => a.startISO.localeCompare(b.startISO))
        .slice(0, 5);

      return {
        handled: true,
        reply:
          idioma === "en"
            ? "I don’t have availability at that exact time. Here are the closest options:"
            : "No tengo disponibilidad a esa hora exacta. Estas son las opciones más cercanas:\n\n" +
              renderSlotsMessage({ idioma, timeZone: tz, slots: take }),
        ctxPatch: {
          booking: {
            step: "offer_slots",
            timeZone: tz,
            purpose: booking?.purpose || null,
            daypart: inferDaypartFromHHMM(hhmm),
            slots: take,
            date_only: ctxDate,
            last_offered_date: ctxDate,
          },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    return {
      handled: true,
      reply:
        idioma === "en"
          ? "I don’t see availability near that time. Would morning or afternoon work better?"
          : "No veo disponibilidad cerca de esa hora. ¿Te funciona más en la mañana o en la tarde?",
      ctxPatch: {
        booking: { ...booking, step: "ask_daypart", timeZone },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  const dp = detectDaypart(userText);
  if (!dp) {
    return {
      handled: true,
      reply: idioma === "en" ? "Please reply: morning or afternoon." : "Respóndeme: mañana o tarde.",
      ctxPatch: {
        booking: { ...booking, step: "ask_daypart", timeZone },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // Si no hay horario configurado: pasamos a ask_all (captura manual)
  if (!hours) {
    return {
      handled: true,
      reply: buildAskAllMessage(idioma, booking?.purpose || null),
      ctxPatch: {
        booking: {
          ...booking,
          step: "ask_all",
          timeZone,
          daypart: dp,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  const slots = await getNextSlotsByDaypart({
    tenantId,
    timeZone,
    durationMin,
    bufferMin,
    hours,
    daypart: dp,
    daysAhead: 7,
  });

  const dateOnlyFromFirst = slots?.[0]?.startISO
    ? DateTime.fromISO(slots[0].startISO, { zone: timeZone }).toFormat("yyyy-MM-dd")
    : null;

  return {
    handled: true,
    reply: renderSlotsMessage({ idioma, timeZone, slots }),
    ctxPatch: {
      booking: {
        step: "offer_slots",
        timeZone,
        purpose: booking?.purpose || null,
        daypart: dp,
        slots,
        date_only: null,
        last_offered_date: dateOnlyFromFirst,
      },
      booking_last_touch_at: Date.now(),
    },
  };
}
