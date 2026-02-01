// src/lib/appointments/booking/handlers/offerSlots.ts
import { DateTime } from "luxon";
import type { TimeConstraint } from "../text";

import {
  normalizeText,
  wantsToCancel,
  wantsMoreSlots,
  wantsAnotherDay,
  wantsToChangeTopic,
  extractTimeOnlyToken,
  extractTimeConstraint,
  extractDateOnlyToken,
} from "../text";

import {
  renderSlotsMessage,
  parseSlotChoice,
  filterSlotsByConstraint,
  filterSlotsNearTime,
  formatSlotHuman,
  filterSlotsByDaypart,
} from "../time";

import { getSlotsForDate, getSlotsForDateWindow } from "../slots";
import { googleFreeBusy } from "../../../../services/googleCalendar";
import { extractBusyBlocks } from "../freebusy";
import { humanizeBookingReply } from "../humanizer";

type Slot = { startISO: string; endISO: string };

export type OfferSlotsDeps = {
  tenantId: string;
  canal: string;

  idioma: "es" | "en";
  userText: string;

  booking: any;
  timeZone: string;
  durationMin: number;
  bufferMin: number;
  minLeadMinutes: number;
  hours: any | null;
};

function hasHHMM(c: any): c is { hhmm: string } {
  return typeof c?.hhmm === "string";
}

function sortSlotsAsc(list: Slot[]) {
  return [...(list || [])].sort((a, b) => a.startISO.localeCompare(b.startISO));
}

function getCtxDateFromBookingOrSlots(slots: Slot[], booking: any, tz: string) {
  return (
    booking?.date_only ||
    booking?.last_offered_date ||
    (slots?.[0]?.startISO
      ? DateTime.fromISO(slots[0].startISO, { zone: tz }).toFormat("yyyy-MM-dd")
      : null)
  );
}

function resolveWeekdayDateISO(userText: string, tz: string, baseISO?: string | null) {
  const s = normalizeText(userText);

  // Luxon weekday: 1=Mon ... 7=Sun
  const map: Record<string, number> = {
    // ES
    lunes: 1,
    martes: 2,
    miercoles: 3,
    miércoles: 3,
    jueves: 4,
    viernes: 5,
    sabado: 6,
    sábado: 6,
    domingo: 7,

    // EN (abreviaciones y full)
    mon: 1,
    monday: 1,
    tue: 2,
    tues: 2,
    tuesday: 2,
    wed: 3,
    weds: 3,
    wednesday: 3,
    thu: 4,
    thur: 4,
    thurs: 4,
    thursday: 4,
    fri: 5,
    friday: 5,
    sat: 6,
    saturday: 6,
    sun: 7,
    sunday: 7,
  };

  let target: number | null = null;
  for (const k of Object.keys(map)) {
    if (new RegExp(`\\b${k}\\b`, "i").test(s)) {
      target = map[k];
      break;
    }
  }
  if (!target) return null;

  const base = baseISO
    ? DateTime.fromFormat(baseISO, "yyyy-MM-dd", { zone: tz })
    : DateTime.now().setZone(tz).startOf("day");

  const diff = (target - base.weekday + 7) % 7; // 0..6
  const picked = base.plus({ days: diff });

  return picked.toFormat("yyyy-MM-dd");
}

export async function handleOfferSlots(deps: OfferSlotsDeps): Promise<{
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
    minLeadMinutes,
    hours,
  } = deps;

  const hydratedBooking = {
    ...booking,
    timeZone: booking?.timeZone || timeZone,
    lang: booking?.lang || idioma, // ✅ sticky lang
  };

  const resetPersonal = {
    name: null,
    email: null,
    phone: hydratedBooking.phone || null,
  };

  const effectiveLang: "es" | "en" = (hydratedBooking.lang as any) || idioma;
  const tz = hydratedBooking.timeZone;
  const calendarId = hydratedBooking?.calendar_id || "primary";

  const t = normalizeText(userText);
  const slotsRaw: Slot[] = Array.isArray(hydratedBooking?.slots) ? hydratedBooking.slots : [];
  const slots: Slot[] = sortSlotsAsc(slotsRaw);

  const daypart = (hydratedBooking?.daypart || null) as ("morning" | "afternoon" | null);
  const step = hydratedBooking?.step;

  const hasPicked = !!hydratedBooking?.picked_start && !!hydratedBooking?.picked_end;
  if (hasPicked && (step === "ask_all" || step === "confirm")) {
    return {
      handled: false,
      ctxPatch: { booking: { ...hydratedBooking }, booking_last_touch_at: Date.now() },
    };
  }

  const slotsShown: Slot[] = daypart ? filterSlotsByDaypart(slots, tz, daypart) : slots;

  // ✅ Sin slots guardados
  if (!slots.length) {
    const canonicalText =
      effectiveLang === "en"
        ? "I don’t have available times saved for that date. Please send another date (YYYY-MM-DD)."
        : "No tengo horarios disponibles guardados para esa fecha. Envíame otra fecha (YYYY-MM-DD).";

    const reply = await humanizeBookingReply({
      idioma: effectiveLang,
      intent: "ask_purpose_clarify", // intent “genérico” para reescritura, el canonical manda
      askedText: userText,
      canonicalText,
      locked: [],
    });

    return {
      handled: true,
      reply,
      ctxPatch: {
        booking: {
          ...hydratedBooking,
          step: "ask_datetime",
          date_only: null,
          slots: [],
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // 0) CAMBIO DE DÍA (antes que wantsMoreSlots)
  if (wantsAnotherDay(userText) && hours) {
    const ctxDate =
      (hydratedBooking as any)?.date_only ||
      (hydratedBooking as any)?.last_offered_date ||
      (slots?.[0]?.startISO
        ? DateTime.fromISO(slots[0].startISO, { zone: tz }).toFormat("yyyy-MM-dd")
        : null);

    if (ctxDate) {
      const nextDate = DateTime.fromFormat(ctxDate, "yyyy-MM-dd", { zone: tz })
        .plus({ days: 1 })
        .toFormat("yyyy-MM-dd");

      let nextSlots = sortSlotsAsc(
        await getSlotsForDate({
          tenantId,
          timeZone: tz,
          dateISO: nextDate,
          durationMin,
          bufferMin,
          minLeadMinutes,
          hours,
          calendarId,
        })
      );

      if (daypart) nextSlots = filterSlotsByDaypart(nextSlots, tz, daypart);

      if (nextSlots.length) {
        const take = nextSlots.slice(0, 3);
        return {
          handled: true,
          reply: renderSlotsMessage({ idioma: effectiveLang, timeZone: tz, slots: take }),
          ctxPatch: {
            booking: {
              ...hydratedBooking,
              step: "offer_slots",
              timeZone: tz,
              slots: take,
              last_offered_date: nextDate,
              date_only: nextDate,
            },
            booking_last_touch_at: Date.now(),
          },
        };
      }
    }

    const canonicalText =
      effectiveLang === "en"
        ? "I don’t see availability on the next day. Want to try a different date?"
        : "No veo disponibilidad para el próximo día. ¿Quieres que probemos otra fecha?";

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
      ctxPatch: { booking: { ...hydratedBooking }, booking_last_touch_at: Date.now() },
    };
  }

  // ⚠️ Solo repetir lista si NO pide hora específica
  const hasExplicitHour = extractTimeOnlyToken(userText) || extractTimeConstraint(userText);

  if (!hasExplicitHour && /\b(horario|horarios|hours|available|disponible|disponibles)\b/i.test(t)) {
    return {
      handled: true,
      reply: renderSlotsMessage({
        idioma: effectiveLang,
        timeZone: tz,
        slots: slotsShown,
      }),
      ctxPatch: { booking: { ...hydratedBooking }, booking_last_touch_at: Date.now() },
    };
  }

  // Cambio de tema
  if (wantsToChangeTopic(userText)) {
    return { handled: false, ctxPatch: { booking: { ...hydratedBooking, step: "idle" } } };
  }

  // Cancelar
  if (wantsToCancel(userText)) {
    const canonicalText =
      effectiveLang === "en"
        ? "No worries — whenever you’re ready to schedule, I’ll be here to help."
        : "No hay problema — cuando necesites agendar, aquí estaré para ayudarte.";

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
        booking: { ...hydratedBooking, step: "idle" },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  const hhmm = extractTimeOnlyToken(userText);

  // Detectar horas sin am/pm ("a las 3", "las 4", "para las 11")
  let hhmmFallback: string | null = null;
  const mSimple = userText.match(/\b(?:a\s*las|a\s*la|las)\s*(\d{1,2})(?:[:.](\d{2}))?\b/i);
  const missingAmPmSimple = !!mSimple && !/\b(am|a\.m\.|pm|p\.m\.)\b/i.test(userText);
  const simpleHour = mSimple ? Number(mSimple[1]) : null;
  const simpleMin = mSimple ? Number(mSimple[2] || "0") : null;

  if (mSimple) {
    let h = Number(mSimple[1]);
    let mm = Number(mSimple[2] || "0");

    if (daypart === "afternoon" && h >= 1 && h <= 11) h += 12;
    if (daypart === "morning" && h === 12) h = 0;

    hhmmFallback = `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }

  const hhmmFixed = hhmm || hhmmFallback;

  // -----------------------------------------
  // 1) Usuario pide una HORA
  // -----------------------------------------
  if (hhmmFixed) {
    if (!hours) {
      const canonicalText =
        effectiveLang === "en"
          ? "What date is that for? (example: 2026-01-26)"
          : "¿Para qué fecha sería? (ej: 2026-01-26)";

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
        ctxPatch: { booking: { ...hydratedBooking }, booking_last_touch_at: Date.now() },
      };
    }

    const dateFromText = extractDateOnlyToken(userText, tz);

    const baseForWeekday =
      (hydratedBooking as any)?.date_only ||
      (hydratedBooking as any)?.last_offered_date ||
      (slots?.[0]?.startISO
        ? DateTime.fromISO(slots[0].startISO, { zone: tz }).toFormat("yyyy-MM-dd")
        : null);

    const weekdayDate = resolveWeekdayDateISO(userText, tz, baseForWeekday);

    const ctxDate =
      dateFromText ||
      weekdayDate ||
      (hydratedBooking as any)?.date_only ||
      (hydratedBooking as any)?.last_offered_date ||
      (slots?.[0]?.startISO
        ? DateTime.fromISO(slots[0].startISO, { zone: tz }).toFormat("yyyy-MM-dd")
        : null);

    if (!ctxDate) {
      const canonicalText =
        effectiveLang === "en"
          ? "What date should I check? (example: 2026-01-26)"
          : "¿Qué fecha debo revisar? (ej: 2026-01-26)";

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
        ctxPatch: { booking: { ...hydratedBooking }, booking_last_touch_at: Date.now() },
      };
    }

    let allDaySlots = sortSlotsAsc(
      await getSlotsForDate({
        tenantId,
        timeZone: tz,
        dateISO: ctxDate,
        durationMin,
        bufferMin,
        minLeadMinutes,
        hours,
        calendarId,
      })
    );

    if (daypart) allDaySlots = filterSlotsByDaypart(allDaySlots, tz, daypart);

    // Desambiguar 3 -> 03:00 vs 15:00 si no hay daypart
    const candidates: string[] = [hhmmFixed];

    if (
      missingAmPmSimple &&
      daypart == null &&
      simpleHour != null &&
      simpleMin != null &&
      simpleHour >= 1 && simpleHour <= 11
    ) {
      const hhPm = simpleHour + 12;
      const hhmmPm = `${String(hhPm).padStart(2, "0")}:${String(simpleMin).padStart(2, "0")}`;
      if (!candidates.includes(hhmmPm)) candidates.push(hhmmPm);
    }

    const exact = allDaySlots.find((s) => {
      const start = DateTime.fromISO(s.startISO, { zone: tz }).toFormat("HH:mm");
      return candidates.includes(start);
    });

    // Si existe exacto, valida freebusy
    if (exact) {
      const fbCheck = await googleFreeBusy({
        tenantId,
        timeMin: DateTime.fromISO(exact.startISO, { zone: tz }).toISO()!,
        timeMax: DateTime.fromISO(exact.endISO, { zone: tz }).toISO()!,
        calendarId,
      });

      const busyNow = extractBusyBlocks(fbCheck, calendarId);

      if (busyNow.length > 0) {
        const refresh = sortSlotsAsc(
          await getSlotsForDate({
            tenantId,
            timeZone: tz,
            dateISO: ctxDate,
            durationMin,
            bufferMin,
            minLeadMinutes,
            hours,
            calendarId,
          })
        );

        const take = (daypart ? filterSlotsByDaypart(refresh, tz, daypart) : refresh).slice(0, 3);
        const optionsText = renderSlotsMessage({ idioma: effectiveLang, timeZone: tz, slots: take });

        const canonicalText =
          effectiveLang === "en"
            ? `That time just got taken. Here are the next available options:\n\n${optionsText}`
            : `Esa hora se acaba de ocupar. Aquí tienes las próximas opciones disponibles:\n\n${optionsText}`;

        const reply = await humanizeBookingReply({
          idioma: effectiveLang,
          intent: "slot_exact_unavailable_with_options",
          askedText: userText,
          canonicalText,
          locked: [optionsText],
          optionsText,
        });

        return {
          handled: true,
          reply,
          ctxPatch: {
            booking: {
              ...hydratedBooking,
              step: "offer_slots",
              timeZone: tz,
              slots: take,
              last_offered_date: ctxDate,
              date_only: ctxDate,
            },
            booking_last_touch_at: Date.now(),
          },
        };
      }
    }

    // ✅ Exacto disponible -> confirm
    if (exact) {
      const prettyWhen = DateTime.fromISO(exact.startISO, { zone: tz })
        .setLocale(effectiveLang === "en" ? "en" : "es")
        .toFormat(effectiveLang === "en" ? "EEE, LLL dd 'at' h:mm a" : "ccc dd LLL, h:mm a");

      const canonicalText =
        effectiveLang === "en"
          ? `Yes — I do have ${prettyWhen} available. Want me to book it?`
          : `Sí — tengo ${prettyWhen} disponible. ¿Quieres que la reserve?`;

      const humanReply = await humanizeBookingReply({
        idioma: effectiveLang,
        intent: "slot_exact_available",
        askedText: userText,
        canonicalText,
        locked: [prettyWhen],
        prettyWhen,
      });

      return {
        handled: true,
        reply: humanReply,
        ctxPatch: {
          booking: {
            ...hydratedBooking,
            step: "confirm",
            timeZone: tz,
            picked_start: exact.startISO,
            picked_end: exact.endISO,
            start_time: exact.startISO,
            end_time: exact.endISO,
            last_offered_date: ctxDate,
            date_only: ctxDate,
            slots: [],
          },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    // No exacto -> cercanos
    const pmCandidate = candidates[1];
    const pmExists =
      !!pmCandidate &&
      allDaySlots.some(
        (s) => DateTime.fromISO(s.startISO, { zone: tz }).toFormat("HH:mm") === pmCandidate
      );

    const near = sortSlotsAsc(
      filterSlotsNearTime({
        slots: allDaySlots,
        timeZone: tz,
        hhmm: pmExists ? pmCandidate : candidates[0],
        windowMinutes: 180,
        max: 5,
      })
    );

    const take = near.length ? near : allDaySlots.slice(0, 3);
    const optionsText = renderSlotsMessage({
      idioma: effectiveLang,
      timeZone: tz,
      slots: take,
      style: "closest",
      ask: "anything",
    });

    const canonicalText =
      effectiveLang === "en"
        ? `I don’t have that exact time. Here are the closest options:\n\n${optionsText}`
        : `No tengo esa hora exacta. Estas son las opciones más cercanas:\n\n${optionsText}`;

    const reply = await humanizeBookingReply({
      idioma: effectiveLang,
      intent: "slot_exact_unavailable_with_options",
      askedText: userText,
      canonicalText,
      locked: [optionsText],
      optionsText,
    });

    return {
      handled: true,
      reply,
      ctxPatch: {
        booking: {
          ...hydratedBooking,
          step: "offer_slots",
          timeZone: tz,
          slots: take,
          last_offered_date: ctxDate,
          date_only: ctxDate,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // -----------------------------------------
  // 2) Número de opción (solo si NO hay hora explícita)
  // -----------------------------------------
  const hasExplicitTime = !!hhmmFixed || !!extractTimeConstraint(userText);

  if (!hasExplicitTime) {
    const choice = parseSlotChoice(userText, slotsShown.length);

    if (!choice) {
      const canonicalText =
        effectiveLang === "en"
          ? `Reply with a number (1-${slotsShown.length}). You can also say a time like "2pm" or "14:00".`
          : `Responde con un número (1-${slotsShown.length}). También puedes decir una hora como "2pm" o "14:00".`;

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
        ctxPatch: { booking: { ...hydratedBooking }, booking_last_touch_at: Date.now() },
      };
    }

    const picked = slotsShown[choice - 1];

    const nextBooking = {
      ...hydratedBooking,
      ...resetPersonal,
      timeZone: tz,
      picked_start: picked.startISO,
      picked_end: picked.endISO,
      start_time: picked.startISO,
      end_time: picked.endISO,
      slot_locked: true,
      slot_locked_at: Date.now(),
      slots: [],
      date_only: getCtxDateFromBookingOrSlots(slotsShown, hydratedBooking, tz),
      last_offered_date: getCtxDateFromBookingOrSlots(slotsShown, hydratedBooking, tz),
    };

    const whenTxt = formatSlotHuman({ startISO: picked.startISO, timeZone: tz, idioma: effectiveLang });

    const requirePhone = deps.canal === "facebook" || deps.canal === "instagram";
    const missingName = !nextBooking?.name;
    const missingEmail = !nextBooking?.email;
    const missingPhone = requirePhone && !nextBooking?.phone;

    if (missingName || missingEmail || missingPhone) {
      const needPhone = requirePhone;

      const fieldsEs = [
        missingName ? "nombre completo" : null,
        missingEmail ? "email" : null,
        needPhone ? "teléfono" : null,
      ].filter(Boolean);

      const fieldsEn = [
        missingName ? "full name" : null,
        missingEmail ? "email" : null,
        needPhone ? "phone" : null,
      ].filter(Boolean);

      const exampleEs = needPhone
        ? "Ej: Juan Pérez, juan@email.com, +13055551234"
        : "Ej: Juan Pérez, juan@email.com";

      const exampleEn = needPhone
        ? "Example: John Smith, john@email.com, +13055551234"
        : "Example: John Smith, john@email.com";

      const canonicalText =
        effectiveLang === "en"
          ? `Perfect — I can do ${whenTxt}. Before I book it, send in ONE message: ${fieldsEn.join(", ")}. ${exampleEn}`
          : `Perfecto — puedo ${whenTxt}. Antes de agendarla, envíame en un solo mensaje: ${fieldsEs.join(", ")}. ${exampleEs}`;

      const reply = await humanizeBookingReply({
        idioma: effectiveLang,
        intent: "ask_purpose",
        askedText: userText,
        canonicalText,
        locked: [whenTxt],
        prettyWhen: whenTxt,
      });

      return {
        handled: true,
        reply,
        ctxPatch: {
          booking: { ...nextBooking, step: "ask_all" },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    // Confirm YES/NO
    const canonicalText =
      effectiveLang === "en"
        ? `Perfect — to confirm ${whenTxt}, reply YES or NO.`
        : `Perfecto — para confirmar ${whenTxt}, responde SI o NO.`;

    const reply = await humanizeBookingReply({
      idioma: effectiveLang,
      intent: "ask_confirm_yes_no",
      askedText: userText,
      canonicalText,
      locked: [whenTxt],
      prettyWhen: whenTxt,
    });

    return {
      handled: true,
      reply,
      ctxPatch: {
        booking: { ...nextBooking, step: "confirm" },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // -----------------------------------------
  // 3) “Más horas / más opciones”
  // -----------------------------------------
  if (wantsMoreSlots(userText) && hours) {
    const ctxDate =
      (hydratedBooking as any)?.date_only ||
      (hydratedBooking as any)?.last_offered_date ||
      (slots?.[0]?.startISO
        ? DateTime.fromISO(slots[0].startISO, { zone: tz }).toFormat("yyyy-MM-dd")
        : null);

    if (ctxDate) {
      let allDaySlots = sortSlotsAsc(
        await getSlotsForDate({
          tenantId,
          timeZone: tz,
          dateISO: ctxDate,
          durationMin,
          bufferMin,
          minLeadMinutes,
          hours,
          calendarId,
        })
      );

      if (daypart) allDaySlots = filterSlotsByDaypart(allDaySlots, tz, daypart);

      if (allDaySlots.length) {
        const take = allDaySlots.slice(0, 3);
        return {
          handled: true,
          reply: renderSlotsMessage({ idioma: effectiveLang, timeZone: tz, slots: take }),
          ctxPatch: {
            booking: {
              ...hydratedBooking,
              step: "offer_slots",
              timeZone: tz,
              slots: take,
              last_offered_date: ctxDate,
              date_only: ctxDate,
            },
            booking_last_touch_at: Date.now(),
          },
        };
      }
    }
  }

  // -----------------------------------------
  // 4) Frases vagas con constraint (“después de las 4”, etc.)
  // -----------------------------------------
  const rawConstraint = extractTimeConstraint(userText);

  if (rawConstraint) {
    let constraint: TimeConstraint = rawConstraint;

    const dp = (hydratedBooking as any)?.daypart || null;
    const missingAmPm = !/\b(am|a\.m\.|pm|p\.m\.)\b/i.test(userText);

    if (
      dp === "afternoon" &&
      missingAmPm &&
      (constraint.kind === "after" ||
        constraint.kind === "before" ||
        constraint.kind === "around") &&
      hasHHMM(constraint)
    ) {
      const h = Number(constraint.hhmm.slice(0, 2));
      const m = Number(constraint.hhmm.slice(3, 5));

      if (h >= 1 && h <= 11) {
        const hh = h + 12;
        constraint = {
          ...constraint,
          hhmm: `${String(hh).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
        };
      }
    }

    const filtered = filterSlotsByConstraint({
      slots: slotsShown,
      timeZone: tz,
      constraint,
      max: 5,
    });

    if (filtered.length) {
      return {
        handled: true,
        reply: renderSlotsMessage({
          idioma: effectiveLang,
          timeZone: tz,
          slots: filtered,
        }),
        ctxPatch: {
          booking: {
            ...hydratedBooking,
            step: "offer_slots",
            timeZone: tz,
            slots: filtered,
          },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    // Re-buscar con ventana si no hubo cerca
    if (hours && hasHHMM(constraint)) {
      const ctxDate =
        (hydratedBooking as any)?.date_only ||
        (hydratedBooking as any)?.last_offered_date ||
        (slots?.[0]?.startISO
          ? DateTime.fromISO(slots[0].startISO, { zone: tz }).toFormat("yyyy-MM-dd")
          : null);

      if (ctxDate) {
        const h = Number(constraint.hhmm.slice(0, 2));
        const m = Number(constraint.hhmm.slice(3, 5));

        const base = DateTime.fromFormat(ctxDate, "yyyy-MM-dd", { zone: tz })
          .set({ hour: h, minute: m, second: 0, millisecond: 0 });

        const windowStartHHmm = base.minus({ hours: 2 }).toFormat("HH:mm");
        const windowEndHHmm = base.plus({ hours: 3 }).toFormat("HH:mm");

        let newSlots = sortSlotsAsc(
          await getSlotsForDateWindow({
            tenantId,
            timeZone: tz,
            dateISO: ctxDate,
            durationMin,
            bufferMin,
            minLeadMinutes,
            hours,
            calendarId,
            windowStartHHmm,
            windowEndHHmm,
          })
        );

        if (daypart) newSlots = filterSlotsByDaypart(newSlots, tz, daypart);

        if (newSlots.length) {
          const take = newSlots.slice(0, 3);
          return {
            handled: true,
            reply: renderSlotsMessage({ idioma: effectiveLang, timeZone: tz, slots: take }),
            ctxPatch: {
              booking: {
                ...hydratedBooking,
                step: "offer_slots",
                timeZone: tz,
                slots: take,
                last_offered_date: ctxDate,
                date_only: ctxDate,
              },
              booking_last_touch_at: Date.now(),
            },
          };
        }
      }
    }

    const canonicalText =
      effectiveLang === "en"
        ? "I don’t see availability near that time. Would you like something earlier or later?"
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
      ctxPatch: { booking: { ...hydratedBooking }, booking_last_touch_at: Date.now() },
    };
  }

  // ✅ Fallback final
  const canonicalText =
    effectiveLang === "en"
      ? `Reply with a number (1-${slotsShown.length}). You can also say a time like "2pm" or "14:00".`
      : `Responde con un número (1-${slotsShown.length}). También puedes decir una hora como "2pm" o "14:00".`;

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
    ctxPatch: { booking: { ...hydratedBooking }, booking_last_touch_at: Date.now() },
  };
}
