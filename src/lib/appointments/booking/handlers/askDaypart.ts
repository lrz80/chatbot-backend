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
import { humanizeBookingReply } from "../humanizer";

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

  // Solo bloquear conversión a PM si el usuario realmente dijo "en la mañana"/"por la mañana"/"morning" o "temprano"
  // (NO incluir "mañana" porque suele significar "tomorrow")
  const morningCue = /\b(en\s+la\s+ma[nñ]ana|por\s+la\s+ma[nñ]ana|temprano|morning|early)\b/.test(s);
  if (morningCue) return hhmm;

  // Si el usuario usa "a las / para las / at / for" y la hora es 1..8,
  // en español casi siempre significa PM (3 -> 15:00)
  const atCue = /\b(a\s+las|a\s+la|para\s+las|para\s+la|at|for)\b/.test(s);
  if (!atCue) return hhmm;

  const h = Number(hhmm.slice(0, 2));
  const m = hhmm.slice(3, 5);

  if (h >= 1 && h <= 8) {
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

  const hydratedBooking = {
    ...booking,
    timeZone: booking?.timeZone || timeZone,     // ✅ sticky tz
    lang: (booking?.lang as any) || idioma,      // ✅ sticky lang
  };

  const effectiveLang: "es" | "en" = (hydratedBooking.lang as any) || idioma;
  const tz = hydratedBooking.timeZone;

  // helper: siempre preserva el lang
  const withLang = (b: any) => ({
    ...(b || {}),
    lang: (b?.lang as any) || effectiveLang,
    timeZone: b?.timeZone || tz, // ✅ sticky tz
  });

  if (wantsToChangeTopic(userText)) {
    return { handled: false, ctxPatch: { booking: withLang({ ...booking, step: "idle" }) } };
  }

  if (wantsToCancel(userText)) {
    const canonicalText =
      effectiveLang === "en"
        ? "No worries — I’ll pause scheduling for now. Whenever you’re ready, just tell me."
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
        booking: withLang({ ...booking, step: "idle" }),
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

  // ✅ normaliza "a las 3" -> 15:00 cuando aplica
  hhmm = normalizeHHMMNatural(userText, hhmm);
  console.log("[ASK_DAYPART hhmm normalized]", { userText, hhmm });

  // ✅ Si el usuario menciona una fecha ("para el 25", "martes", "mañana", etc.)
  const dateOnly = extractDateOnlyToken(userText, tz);

  // ✅ FECHA + HORA: intentamos exacto; si no, cercanos
  if (dateOnly && hhmm) {
    // Si no hay horario configurado, pedir todo manualmente pero guardar date_only
    if (!hours) {
      return {
        handled: true,
        reply: buildAskAllMessage(idioma, booking?.purpose || null),
        ctxPatch: {
          booking: withLang({
            ...booking,
            step: "ask_all",
            timeZone: tz,
            date_only: dateOnly,
            daypart: inferDaypartFromHHMM(hhmm),
          }),
          booking_last_touch_at: Date.now(),
        },
      };
    }

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

    if (windowSlots?.length) {
      const exact = windowSlots.find((s) => {
        const start = DateTime.fromISO(s.startISO, { zone: tz }).toFormat("HH:mm");
        return start === hhmm;
      });

      // ✅ Exacto -> confirm directo (sin lista)
      if (exact) {
        const prettyWhen = DateTime.fromISO(exact.startISO, { zone: tz })
          .setLocale(effectiveLang === "en" ? "en" : "es")
          .toFormat(effectiveLang === "en" ? "EEE, LLL dd 'at' h:mm a" : "ccc dd LLL, h:mm a");

        const canonicalText =
          effectiveLang === "en"
            ? `Yes — I do have ${prettyWhen} available. Want me to book it?`
            : `Sí — tengo ${prettyWhen} disponible. ¿Quieres que la reserve?`;

        const reply = await humanizeBookingReply({
          idioma: effectiveLang,
          intent: "slot_exact_available",
          askedText: userText,
          canonicalText,
          locked: [prettyWhen],
          prettyWhen,
        });

        return {
          handled: true,
          reply,
          ctxPatch: {
            booking: withLang({
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
              slots: [],
            }),
            booking_last_touch_at: Date.now(),
          },
        };
      }

      // ❌ No exacto -> cercanos
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
          ? (effectiveLang === "en"
              ? `For ${DateTime.fromFormat(dateOnly, "yyyy-MM-dd", { zone: tz }).setLocale("en").toFormat("EEE, LLL dd")}, `
              : `Para ${DateTime.fromFormat(dateOnly, "yyyy-MM-dd", { zone: tz }).setLocale("es").toFormat("ccc dd LLL")}, `)
          : "";

      const optionsText = renderSlotsMessage({ idioma, timeZone: tz, slots: take });

      const canonicalText =
        effectiveLang === "en"
          ? `${datePrefix}I don’t have that exact time. Here are the closest options:\n\n${optionsText}`
          : `${datePrefix}No tengo esa hora exacta. Estas son las opciones más cercanas:\n\n${optionsText}`;

      const reply = await humanizeBookingReply({
        idioma: effectiveLang,
        intent: "slot_exact_unavailable_with_options",
        askedText: userText,
        canonicalText,
        locked: [datePrefix, optionsText].filter(Boolean),
        optionsText,
        datePrefix,
      });

      return {
        handled: true,
        reply,
        ctxPatch: {
          booking: withLang({
            ...booking,
            step: "offer_slots",
            timeZone: tz,
            purpose: booking?.purpose || null,
            daypart: inferDaypartFromHHMM(hhmm),
            slots: take,
            date_only: dateOnly,
            last_offered_date: dateOnly,
          }),
          booking_last_touch_at: Date.now(),
        },
      };
    }

    // Si la ventana no devolvió nada, cae al flujo normal de dateOnly
  }

  if (dateOnly) {
    // Sin horario: captura manual
    if (!hours) {
      return {
        handled: true,
        reply: buildAskAllMessage(idioma, booking?.purpose || null),
        ctxPatch: {
          booking: {
            ...booking,
            step: "ask_all",
            timeZone: tz,
            date_only: dateOnly,
          },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    // Slots del día
    const slotsForDay = await getSlotsForDateOnly({
      tenantId,
      timeZone: tz,
      durationMin,
      bufferMin,
      hours,
      dateOnly,
      minLeadMinutes,
    });

    if (!slotsForDay?.length) {
      const canonicalText =
        effectiveLang === "en"
          ? "I don’t have openings that day. Want to try another day or morning/afternoon?"
          : "Ese día no tengo disponibilidad. ¿Quieres probar otro día o prefieres mañana/tarde?";

      const reply = await humanizeBookingReply({
        idioma: effectiveLang,
        intent: "no_openings_that_day",
        askedText: userText,
        canonicalText,
        locked: [],
      });

      return {
        handled: true,
        reply,
        ctxPatch: {
          booking: withLang({ ...booking, step: "ask_daypart" }),
          booking_last_touch_at: Date.now(),
        },
      };
    }

    return {
      handled: true,
      reply: renderSlotsMessage({ idioma, timeZone: tz, slots: slotsForDay }),
      ctxPatch: {
        booking: {
          step: "offer_slots",
          timeZone: tz,
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

  // ✅ Solo HORA ("3pm", "15:00", "a las 3") sin fecha
  if (hhmm) {
    console.log("[ASK_DAYPART hhmm]", { userText, hhmm });

    if (!hours) {
      return {
        handled: true,
        reply: buildAskAllMessage(idioma, booking?.purpose || null),
        ctxPatch: {
          booking: withLang({
            ...booking,
            step: "ask_all",
            timeZone: tz,
            daypart: inferDaypartFromHHMM(hhmm),
          }),
          booking_last_touch_at: Date.now(),
        },
      };
    }

    const now = DateTime.now().setZone(tz);

    // si hoy está cerrado, busca próximo día abierto
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

    if (windowSlots?.length) {
      const exact = windowSlots.find((s) => {
        const start = DateTime.fromISO(s.startISO, { zone: tz }).toFormat("HH:mm");
        return start === hhmm;
      });

      const todayISO = now.toFormat("yyyy-MM-dd");
      const datePrefix =
        ctxDate !== todayISO
          ? (effectiveLang === "en"
              ? `For ${DateTime.fromFormat(ctxDate, "yyyy-MM-dd", { zone: tz }).setLocale("en").toFormat("EEE, LLL dd")}, `
              : `Para ${DateTime.fromFormat(ctxDate, "yyyy-MM-dd", { zone: tz }).setLocale("es").toFormat("ccc dd LLL")}, `)
          : "";

      if (exact) {
        const prettyWhen = DateTime.fromISO(exact.startISO, { zone: tz })
          .setLocale(effectiveLang === "en" ? "en" : "es")
          .toFormat(effectiveLang === "en" ? "EEE, LLL dd 'at' h:mm a" : "ccc dd LLL, h:mm a");

        const canonicalText =
          effectiveLang === "en"
            ? `${datePrefix}Yes — I do have ${prettyWhen} available. Want me to book it?`
            : `${datePrefix}Sí — tengo ${prettyWhen} disponible. ¿Quieres que la reserve?`;

        const reply = await humanizeBookingReply({
          idioma: effectiveLang,
          intent: "slot_exact_available",
          askedText: userText,
          canonicalText,
          locked: [datePrefix, prettyWhen].filter(Boolean),
          prettyWhen,
          datePrefix,
        });

        return {
          handled: true,
          reply,
          ctxPatch: {
            booking: withLang({
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
            }),
            booking_last_touch_at: Date.now(),
          },
        };
      }

      // no exacto -> cercanos
      const take = pickClosestSlotsToHHMM({
        slots: windowSlots,
        timeZone: tz,
        dateISO: ctxDate,
        hhmm,
        max: 5,
      });

      const optionsText = renderSlotsMessage({ idioma, timeZone: tz, slots: take });

      const canonicalText =
        effectiveLang === "en"
          ? `${datePrefix}I don’t have that exact time. Here are the closest options:\n\n${optionsText}`
          : `${datePrefix}No tengo esa hora exacta. Estas son las opciones más cercanas:\n\n${optionsText}`;

      const reply = await humanizeBookingReply({
        idioma: effectiveLang,
        intent: "slot_exact_unavailable_with_options",
        askedText: userText,
        canonicalText,
        locked: [datePrefix, optionsText].filter(Boolean),
        optionsText,
        datePrefix,
      });

      return {
        handled: true,
        reply,
        ctxPatch: {
          booking: withLang({
            ...booking,
            step: "offer_slots",
            timeZone: tz,
            purpose: booking?.purpose || null,
            daypart: inferDaypartFromHHMM(hhmm),
            slots: take,
            date_only: ctxDate,
            last_offered_date: ctxDate,
          }),
          booking_last_touch_at: Date.now(),
        },
      };
    }

    // Fallback: día completo
    const allDaySlots = await getSlotsForDate({
      tenantId,
      timeZone: tz,
      dateISO: ctxDate,
      durationMin,
      bufferMin,
      hours,
      minLeadMinutes,
    });

    if (allDaySlots?.length) {
      const exact = allDaySlots.find((s) => {
        const start = DateTime.fromISO(s.startISO, { zone: tz }).toFormat("HH:mm");
        return start === hhmm;
      });

      const todayISO = now.toFormat("yyyy-MM-dd");
      const datePrefix =
        ctxDate !== todayISO
          ? (effectiveLang === "en"
              ? `For ${DateTime.fromFormat(ctxDate, "yyyy-MM-dd", { zone: tz }).setLocale("en").toFormat("EEE, LLL dd")}, `
              : `Para ${DateTime.fromFormat(ctxDate, "yyyy-MM-dd", { zone: tz }).setLocale("es").toFormat("ccc dd LLL")}, `)
          : "";

      if (exact) {
        const prettyWhen = DateTime.fromISO(exact.startISO, { zone: tz })
          .setLocale(effectiveLang === "en" ? "en" : "es")
          .toFormat(effectiveLang === "en" ? "EEE, LLL dd 'at' h:mm a" : "ccc dd LLL, h:mm a");

        const canonicalText =
          effectiveLang === "en"
            ? `${datePrefix}Yes — I do have ${prettyWhen} available. Want me to book it?`
            : `${datePrefix}Sí — tengo ${prettyWhen} disponible. ¿Quieres que la reserve?`;

        const reply = await humanizeBookingReply({
          idioma: effectiveLang,
          intent: "slot_exact_available",
          askedText: userText,
          canonicalText,
          locked: [datePrefix, prettyWhen].filter(Boolean),
          prettyWhen,
          datePrefix,
        });

        return {
          handled: true,
          reply,
          ctxPatch: {
            booking: withLang({
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
            }),
            booking_last_touch_at: Date.now(),
          },
        };
      }

      const take = pickClosestSlotsToHHMM({
        slots: allDaySlots,
        timeZone: tz,
        dateISO: ctxDate,
        hhmm,
        max: 5,
      });

      const optionsText = renderSlotsMessage({ idioma, timeZone: tz, slots: take });

      const canonicalText =
        effectiveLang === "en"
          ? `${datePrefix}I don’t have that exact time. Here are the closest options:\n\n${optionsText}`
          : `${datePrefix}No tengo esa hora exacta. Estas son las opciones más cercanas:\n\n${optionsText}`;

      const reply = await humanizeBookingReply({
        idioma: effectiveLang,
        intent: "slot_exact_unavailable_with_options",
        askedText: userText,
        canonicalText,
        locked: [datePrefix, optionsText].filter(Boolean),
        optionsText,
        datePrefix,
      });

      return {
        handled: true,
        reply,
        ctxPatch: {
          booking: withLang({
            ...booking,
            step: "offer_slots",
            timeZone: tz,
            purpose: booking?.purpose || null,
            daypart: inferDaypartFromHHMM(hhmm),
            slots: take,
            date_only: ctxDate,
            last_offered_date: ctxDate,
          }),
          booking_last_touch_at: Date.now(),
        },
      };
    }

    // ✅ nada cerca
    const canonicalText =
      effectiveLang === "en"
        ? "I don’t see openings near that time. Would you prefer earlier or later?"
        : "No veo disponibilidad cerca de esa hora. ¿Te sirve más temprano o más tarde?";

    const reply = await humanizeBookingReply({
      idioma: effectiveLang,
      intent: "no_availability_near_time",
      askedText: userText,
      canonicalText,
      locked: [],
    });

    return {
      handled: true,
      reply,
      ctxPatch: {
        booking: withLang({ ...booking, step: "ask_daypart" }),
        booking_last_touch_at: Date.now(),
      },
    };
  }

  const dp = detectDaypart(userText);
  if (!dp) {
    const canonicalText =
      effectiveLang === "en"
        ? "Got you — do you prefer morning or afternoon?"
        : "Entiendo — ¿te funciona mejor en la mañana o en la tarde?";

    const reply = await humanizeBookingReply({
      idioma: effectiveLang,
      intent: "ask_daypart_retry",
      askedText: userText,
      canonicalText,
      locked: [],
    });

    return {
      handled: true,
      reply,
      ctxPatch: {
        booking: withLang({ ...booking, step: "ask_daypart" }),
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // Si no hay horario configurado: ask_all (captura manual)
  if (!hours) {
    return {
      handled: true,
      reply: buildAskAllMessage(idioma, booking?.purpose || null),
      ctxPatch: {
        booking: {
          ...booking,
          step: "ask_all",
          timeZone: tz,
          daypart: dp,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  const slots = await getNextSlotsByDaypart({
    tenantId,
    timeZone: tz,
    durationMin,
    bufferMin,
    hours,
    daypart: dp,
    daysAhead: 7,
    minLeadMinutes,
  });

  const dateOnlyFromFirst = slots?.[0]?.startISO
    ? DateTime.fromISO(slots[0].startISO, { zone: tz }).toFormat("yyyy-MM-dd")
    : null;

  return {
    handled: true,
    reply: renderSlotsMessage({ idioma, timeZone: tz, slots }),
    ctxPatch: {
      booking: {
        step: "offer_slots",
        timeZone: tz,
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
