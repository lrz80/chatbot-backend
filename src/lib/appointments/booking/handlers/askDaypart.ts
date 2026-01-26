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
  minLeadMinutes: number;
};

function inferDaypartFromHHMM(hhmm: string): "morning" | "afternoon" {
  const h = Number(hhmm.slice(0, 2));
  return h >= 12 ? "afternoon" : "morning";
}

function normalizeHHMMNatural(userText: string, hhmm: string | null): string | null {
  if (!hhmm) return null;

  const s = String(userText || "").toLowerCase();

  // Si el usuario ya especificó am/pm o "pm" o "a.m/p.m", NO tocamos nada
  const hasAmPm = /\b(am|pm|a\.m\.|p\.m\.)\b/.test(s);
  if (hasAmPm) return hhmm;

  // Si el usuario da señales de mañana, NO convertir a PM
  const morningCue = /\b(ma[nñ]ana|temprano|morning|a\s+primera\s+hora)\b/.test(s);
  if (morningCue) return hhmm;

  // Si el usuario usa "a las / para las / at / for" y la hora es 1..7,
  // en español casi siempre significa PM (3 -> 15:00)
  const atCue = /\b(a\s+las|a\s+la|para\s+las|para\s+la|at|for)\b/.test(s);
  if (!atCue) return hhmm;

  const h = Number(hhmm.slice(0, 2));
  const m = hhmm.slice(3, 5);

  if (h >= 1 && h <= 7) {
    const hh = String(h + 12).padStart(2, "0");
    return `${hh}:${m}`;
  }

  return hhmm;
}

function weekdayKeyFromDate(dt: DateTime) {
  // Luxon weekday: 1=Mon ... 7=Sun
  const map = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
  return map[dt.weekday - 1];
}

function isOpenOnDate(hours: any, dt: DateTime) {
  const k = weekdayKeyFromDate(dt);
  const day = hours?.[k];
  return day && day.start && day.end; // tu JSON es {start,end} o null
}

function pickClosestSlotsToHHMM(opts: {
  slots: Array<{ startISO: string; endISO: string }>;
  timeZone: string;
  dateISO: string;  // yyyy-MM-dd
  hhmm: string;     // HH:mm
  max: number;
}) {
  const { slots, timeZone, dateISO, hhmm, max } = opts;

  const h = Number(hhmm.slice(0, 2));
  const m = Number(hhmm.slice(3, 5));

  const target = DateTime.fromFormat(dateISO, "yyyy-MM-dd", { zone: timeZone })
    .set({ hour: h, minute: m, second: 0, millisecond: 0 })
    .toMillis();

  return [...slots]
    .sort((a, b) => {
      const am = DateTime.fromISO(a.startISO, { zone: timeZone }).toMillis();
      const bm = DateTime.fromISO(b.startISO, { zone: timeZone }).toMillis();
      return Math.abs(am - target) - Math.abs(bm - target);
    })
    .slice(0, max);
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
    minLeadMinutes,
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

  // ✅ Precalcular hhmm desde el texto (para que dateOnly no se trague la hora)
  let hhmm =
    extractTimeOnlyToken(userText) ||
    (() => {
      const c: any = extractTimeConstraint(userText);
      return typeof c?.hhmm === "string" ? c.hhmm : null;
    })();

    // ✅ NUEVO: normaliza "a las 3" -> 15:00 cuando aplica
    hhmm = normalizeHHMMNatural(userText, hhmm);
    console.log("[ASK_DAYPART hhmm normalized]", { userText, hhmm });

    // ✅ Si el usuario menciona una fecha ("para el 25", "martes", "mañana", etc.)
    // en vez de daypart, debemos continuar el flujo ofreciendo slots para esa fecha.
    const dateOnly = extractDateOnlyToken(userText, timeZone);

    // ✅ Opción B: si el usuario trae FECHA + HORA (ej "lunes a las 2pm"),
    // intentamos esa hora exacta primero; si no existe, damos las más cercanas.
    if (dateOnly && hhmm) {
      // Si no hay horario configurado, pedir todo manualmente pero guardar date_only
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
              daypart: inferDaypartFromHHMM(hhmm),
            },
            booking_last_touch_at: Date.now(),
          },
        };
      }

    const tz = timeZone;
    const now = DateTime.now().setZone(tz);

    // Ventana real alrededor de la hora pedida (2h antes, 3h después)
    const h = Number(hhmm.slice(0, 2));
    const m = Number(hhmm.slice(3, 5));

    const base = DateTime.fromFormat(dateOnly, "yyyy-MM-dd", { zone: tz })
      .set({ hour: h, minute: m, second: 0, millisecond: 0 });

    const windowStartHHmm = base.minus({ hours: 2 }).toFormat("HH:mm");
    const windowEndHHmm = base.plus({ hours: 3 }).toFormat("HH:mm");

    const windowSlots = await getSlotsForDateWindow({
      tenantId,
      timeZone: tz,
      dateISO: dateOnly,
      durationMin,
      bufferMin,
      hours,
      windowStartHHmm,
      windowEndHHmm,
      minLeadMinutes,
    });

    // 1) Si existe EXACTO, pasamos a confirm (NO lista)
    if (windowSlots?.length) {
      const exact = windowSlots.find((s) => {
        const start = DateTime.fromISO(s.startISO, { zone: tz }).toFormat("HH:mm");
        return start === hhmm;
      });

      if (exact) {
        const pretty = DateTime.fromISO(exact.startISO, { zone: tz })
          .setLocale(idioma === "en" ? "en" : "es")
          .toFormat(idioma === "en" ? "EEE, LLL dd 'at' h:mm a" : "ccc dd LLL, h:mm a");

        return {
          handled: true,
          reply:
            idioma === "en"
              ? `Perfect, I have available ${pretty}. Do you want to confirm this time? (yes/no)`
              : `Perfecto, tengo disponible ${pretty}. ¿Confirmas ese horario? (sí/no)`,
          ctxPatch: {
            booking: {
              ...booking,
              step: "confirm",
              timeZone: tz,
              purpose: booking?.purpose || null,
              daypart: inferDaypartFromHHMM(hhmm),
              start_time: exact.startISO,
              end_time: exact.endISO,
              picked_start: exact.startISO,
              picked_end: exact.endISO,
              date_only: dateOnly,
              last_offered_date: dateOnly,
              slots: [], // ✅ sin lista
            },
            booking_last_touch_at: Date.now(),
          },
        };
      }

      // 2) Si NO hay exacto, damos los más cercanos (lista 1-5)
      const take = pickClosestSlotsToHHMM({
        slots: windowSlots,
        timeZone: tz,
        dateISO: dateOnly,
        hhmm,
        max: 5,
      });

      const todayISO = now.toFormat("yyyy-MM-dd");
      const datePrefix =
        dateOnly !== todayISO
          ? (idioma === "en"
              ? `For ${DateTime.fromFormat(dateOnly, "yyyy-MM-dd", { zone: tz }).setLocale("en").toFormat("EEE, LLL dd")}, `
              : `Para ${DateTime.fromFormat(dateOnly, "yyyy-MM-dd", { zone: tz }).setLocale("es").toFormat("ccc dd LLL")}, `)
          : "";

      return {
        handled: true,
        reply:
          idioma === "en"
            ? `${datePrefix}I don’t have that exact time. Here are the closest options:\n\n` +
              renderSlotsMessage({ idioma, timeZone: tz, slots: take })
            : `${datePrefix}No tengo esa hora exacta. Estas son las opciones más cercanas:\n\n` +
              renderSlotsMessage({ idioma, timeZone: tz, slots: take }),
        ctxPatch: {
          booking: {
            ...booking,
            step: "offer_slots",
            timeZone: tz,
            purpose: booking?.purpose || null,
            daypart: inferDaypartFromHHMM(hhmm),
            slots: take,
            date_only: dateOnly,
            last_offered_date: dateOnly,
          },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    // Si la ventana no devolvió nada, cae a tu flujo normal de dateOnly (slots del día)
    // No retornamos aquí; dejamos que siga al if (dateOnly)
  }

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
      dateOnly, 
      minLeadMinutes,
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
  if (hhmm) {
    console.log("[ASK_DAYPART hhmm]", { userText, hhmm });
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
    const now = DateTime.now().setZone(tz);

    // Si hoy está cerrado, busca el próximo día abierto (máx 14 días)
    let dt = now.startOf("day");
    if (!isOpenOnDate(hours, dt)) {
    for (let i = 1; i < 14; i++) {
        const cand = dt.plus({ days: i });
        if (isOpenOnDate(hours, cand)) {
        dt = cand;
        break;
        }
    }
    }

    const ctxDate =
    booking?.date_only ||
    booking?.last_offered_date ||
    dt.toFormat("yyyy-MM-dd");

    const h = Number(hhmm.slice(0, 2));
    const m = Number(hhmm.slice(3, 5));

    const base = DateTime.fromFormat(ctxDate, "yyyy-MM-dd", { zone: tz })
      .set({ hour: h, minute: m, second: 0, millisecond: 0 });

    const windowStartHHmm = base.minus({ hours: 2 }).toFormat("HH:mm");
    const windowEndHHmm = base.plus({ hours: 3 }).toFormat("HH:mm");

    console.log("[DEBUG HOURS]", {
      hours,
    });

    console.log("[ASK_DAYPART preWindow]", {
      ctxDate,
      tz,
      now: now.toISO(),
      windowStartHHmm,
      windowEndHHmm,
      durationMin,
      bufferMin,
    });

    const windowSlots = await getSlotsForDateWindow({
      tenantId,
      timeZone: tz,
      dateISO: ctxDate,
      durationMin,
      bufferMin,
      hours,
      windowStartHHmm,
      windowEndHHmm,
      minLeadMinutes,
    });

    console.log(
      "[ASK_DAYPART windowSlots HH:mm]",
      (windowSlots || []).map(s =>
        DateTime.fromISO(s.startISO, { zone: tz }).toFormat("HH:mm")
      )
    );

    if (windowSlots?.length) {
      // ✅ 1) Si existe EXACTO, CONFIRMAMOS (NO lista)
      const exact = windowSlots.find((s) => {
        const start = DateTime.fromISO(s.startISO, { zone: tz }).toFormat("HH:mm");
        return start === hhmm;
      });

      const todayISO = now.toFormat("yyyy-MM-dd");
      const datePrefix =
      ctxDate !== todayISO
        ? (idioma === "en"
            ? `For ${DateTime.fromFormat(ctxDate, "yyyy-MM-dd", { zone: tz }).setLocale("en").toFormat("EEE, LLL dd")}, `
            : `Para ${DateTime.fromFormat(ctxDate, "yyyy-MM-dd", { zone: tz }).setLocale("es").toFormat("ccc dd LLL")}, `)
        : "";

      if (exact) {
        const pretty = DateTime.fromISO(exact.startISO, { zone: tz })
          .setLocale(idioma === "en" ? "en" : "es")
          .toFormat(idioma === "en" ? "EEE, LLL dd 'at' h:mm a" : "ccc dd LLL, h:mm a");

        return {
          handled: true,
          reply:
            idioma === "en"
              ? `Perfect, I have available ${pretty}. Do you want to confirm this time? (yes/no)`
              : `Perfecto, tengo disponible ${pretty}. ¿Confirmas ese horario? (sí/no)`,
          ctxPatch: {
            booking: {
              ...booking,
              step: "confirm",
              timeZone: tz,
              purpose: booking?.purpose || null,
              daypart: inferDaypartFromHHMM(hhmm),
              start_time: exact.startISO,
              end_time: exact.endISO,
              picked_start: exact.startISO,
              picked_end: exact.endISO,
              date_only: ctxDate,
              last_offered_date: ctxDate,
              slots: [], // ✅ importante: sin lista
            },
            booking_last_touch_at: Date.now(),
          },
        };
      }

      // ✅ 2) Si NO hay exacto, entonces sí devolvemos opciones cercanas (lista 1-5)
      const take = pickClosestSlotsToHHMM({
        slots: windowSlots,
        timeZone: tz,
        dateISO: ctxDate,
        hhmm,
        max: 5,
      });

      return {
        handled: true,
        reply:
          idioma === "en"
            ? `${datePrefix}I don’t have that exact time. Here are the closest options:\n\n` +
              renderSlotsMessage({ idioma, timeZone: tz, slots: take })
            : `${datePrefix}No tengo esa hora exacta. Estas son las opciones más cercanas:\n\n` +
              renderSlotsMessage({ idioma, timeZone: tz, slots: take }),
          ctxPatch: {
            booking: {
              ...booking,
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
      minLeadMinutes,
    });

    console.log(
      "[ASK_DAYPART allDay HH:mm]",
      (allDaySlots || []).map(s =>
        DateTime.fromISO(s.startISO, { zone: tz }).toFormat("HH:mm")
      )
    );

    console.log("[ASK_DAYPART allDay checks]", {
      has1400: (allDaySlots || []).some(s =>
        DateTime.fromISO(s.startISO, { zone: tz }).toFormat("HH:mm") === "14:00"
      ),
      hasRequested: (allDaySlots || []).some(s =>
        DateTime.fromISO(s.startISO, { zone: tz }).toFormat("HH:mm") === hhmm
      ),
    });

    if (allDaySlots?.length) {
    const exact = allDaySlots.find((s) => {
        const start = DateTime.fromISO(s.startISO, { zone: tz }).toFormat("HH:mm");
        return start === hhmm;
    });

    const todayISO = now.toFormat("yyyy-MM-dd");
    const datePrefix =
        ctxDate !== todayISO
        ? (idioma === "en"
            ? `The next availability date on: ${ctxDate}. `
            : `La próxima fecha disponible es: ${ctxDate}. `)
        : "";

    // ✅ SI EXISTE EXACTO → CONFIRMAR DIRECTO (NO LISTA)
    if (exact) {
        const pretty = DateTime.fromISO(exact.startISO, { zone: tz })
        .setLocale(idioma === "en" ? "en" : "es")
        .toFormat(idioma === "en" ? "EEE, LLL dd 'at' h:mm a" : "ccc dd LLL, h:mm a");

        return {
        handled: true,
        reply:
            idioma === "en"
              ? `Perfect, I have available ${pretty}. Do you want to confirm this time? (yes/no)`
              : `Perfecto, tengo disponible ${pretty}. ¿Confirmas ese horario? (sí/no)`,
        ctxPatch: {
            booking: {
            ...booking,
            step: "confirm",
            timeZone: tz,
            purpose: booking?.purpose || null,
            daypart: inferDaypartFromHHMM(hhmm),
            start_time: exact.startISO,
            end_time: exact.endISO,
            picked_start: exact.startISO,
            picked_end: exact.endISO,
            date_only: ctxDate,
            last_offered_date: ctxDate,
            slots: [],
            },
            booking_last_touch_at: Date.now(),
        },
        };
    }

    // ✅ SI NO HAY EXACTO → DEVOLVER LISTA CERCANA
    const take = pickClosestSlotsToHHMM({
        slots: allDaySlots,
        timeZone: tz,
        dateISO: ctxDate,
        hhmm,
        max: 5,
    });

    return {
        handled: true,
        reply:
        idioma === "en"
            ? `${datePrefix}I don’t have that exact time. Here are the closest options:\n\n` +
            renderSlotsMessage({ idioma, timeZone: tz, slots: take })
            : `${datePrefix}No tengo esa hora exacta. Estas son las opciones más cercanas:\n\n` +
            renderSlotsMessage({ idioma, timeZone: tz, slots: take }),
        ctxPatch: {
        booking: {
            ...booking,
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
    minLeadMinutes,
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
