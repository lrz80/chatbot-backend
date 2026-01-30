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

type Slot = { startISO: string; endISO: string };

export type OfferSlotsDeps = {
  tenantId: string;
  canal: string;
  contacto: string;
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

  // busca si el texto contiene algún día
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
    phone: null,
  };

  const effectiveLang: "es" | "en" = (hydratedBooking.lang as any) || idioma;

  const tz = hydratedBooking.timeZone;

  const calendarId = hydratedBooking?.calendar_id || "primary";

  const t = normalizeText(userText);
  const slotsRaw: Slot[] = Array.isArray(hydratedBooking?.slots) ? hydratedBooking.slots : [];
  const slots: Slot[] = sortSlotsAsc(slotsRaw);
  
  const daypart = (hydratedBooking?.daypart || null) as ("morning" | "afternoon" | null);

  // ✅ Esto es EXACTAMENTE lo que el usuario debe ver y elegir
  const slotsShown: Slot[] = daypart ? filterSlotsByDaypart(slots, tz, daypart) : slots;

      if (!slots.length) {
        return {
          handled: true,
          reply: effectiveLang === "en"
            ? "I'm sorry! I don’t have available times saved for that date. Please send another date (YYYY-MM-DD)."
            : "Lo siento! No tengo horarios disponibles para esa fecha. Envíame otra fecha (YYYY-MM-DD).",
          ctxPatch: {
              booking: {
              ...hydratedBooking,
                  step: "ask_datetime",
                  date_only: null,
                  slots: [],},
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
          // siguiente día
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
            const take = nextSlots.slice(0, 5);
            return {
                handled: true,
                reply: renderSlotsMessage({ idioma:effectiveLang, timeZone: tz, slots: take }),
                ctxPatch: {
                booking: {
                    ...hydratedBooking,
                    step: "offer_slots",
                    timeZone: tz,
                    slots: take,                 // ✅ guarda lo filtrado
                    last_offered_date: nextDate,
                    date_only: nextDate,
                },
                booking_last_touch_at: Date.now(),
                },
            };
          }
        }
  
        return {
          handled: true,
          reply: effectiveLang === "en"
            ? "I'm sorry! I don’t see availability on the next day. Would you like to try a different date?"
            : "Lo siento! No veo disponibilidad para el próximo día. ¿Quieres que probemos otra fecha?",
          ctxPatch: { booking: {...hydratedBooking}, booking_last_touch_at: Date.now() },
        };
      }
  
      // ⚠️ Solo repetir lista si NO está pidiendo una hora específica (2pm, 14:00, 3pm)
      const hasExplicitHour =
      extractTimeOnlyToken(userText) ||
      extractTimeConstraint(userText);

      if (!hasExplicitHour && /\b(horario|horarios|hours|available|disponible|disponibles)\b/i.test(t)) {
        return {
          handled: true,
          reply: renderSlotsMessage({
            idioma: effectiveLang,
            timeZone: tz,
            slots: slotsShown,
          }),
          ctxPatch: { booking: {...hydratedBooking}, booking_last_touch_at: Date.now() },
        };
      }
  
      // Ahora sí, cualquier otro cambio de tema
      if (wantsToChangeTopic(userText)) {
      return { handled: false, ctxPatch: { booking: { ...hydratedBooking, step: "idle" } } };
      }
  
    if (wantsToCancel(userText)) {
      return {
        handled: true,
        reply: effectiveLang === "en"
          ? "No worries, whenever you’re ready to schedule, I’ll be here to help."
          : "No hay problema, cuando necesites agendar estaré aquí para ayudarte.",
        ctxPatch: { 
          booking: { ...hydratedBooking, step: "idle" },
          booking_last_touch_at: Date.now(),
        },
      };
    }
  
    const hhmm = extractTimeOnlyToken(userText);

    // Detectar horas sin am/pm ("a las 3", "las 4", "para las 11")
    let hhmmFallback = null;
    const mSimple = userText.match(/\b(?:a\s*las|a\s*la|las)\s*(\d{1,2})(?:[:.](\d{2}))?\b/i);
    const missingAmPmSimple = !!mSimple && !/\b(am|a\.m\.|pm|p\.m\.)\b/i.test(userText);
    const simpleHour = mSimple ? Number(mSimple[1]) : null;
    const simpleMin = mSimple ? Number(mSimple[2] || "0") : null;

    if (mSimple) {
    let h = Number(mSimple[1]);
    let mm = Number(mSimple[2] || "0");

    // Si existe daypart -> infiere AM/PM
    if (daypart === "afternoon" && h >= 1 && h <= 11) h += 12;
    if (daypart === "morning" && h === 12) h = 0;

    hhmmFallback = `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    }

    // final
    const hhmmFixed = hhmm || hhmmFallback;

    if (hhmmFixed) {
      if (!hours) {
        return {
          handled: true,
          reply: effectiveLang === "en"
            ? "What date is that for? (example: 2026-01-26)"
            : "¿Para qué fecha sería? (ej: 2026-01-26)",
          ctxPatch: { booking: {...hydratedBooking}, booking_last_touch_at: Date.now() },
        };
      }

      // ✅ si el usuario escribió una fecha ("lunes", "mañana", "26 ene"), úsala por encima del ctx
      const dateFromText = extractDateOnlyToken(userText, tz);

      // ✅ NUEVO: si escribió "miércoles / wed", conviértelo a yyyy-MM-dd
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
        return {
          handled: true,
          reply: effectiveLang === "en"
            ? "What date should I check? (example: 2026-01-26)"
            : "¿Qué fecha debo revisar? (ej: 2026-01-26)",
          ctxPatch: { booking: {...hydratedBooking}, booking_last_touch_at: Date.now() },
        };
      }

      // ✅ 1) Siempre calcula el día completo para saber si existe EXACTO (2pm)
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

      // ✅ Desambiguar "a las 3" sin AM/PM cuando NO hay daypart:
      // probamos 03:00 y luego 15:00 si aplica y existe en slots del día
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

          const take = (daypart ? filterSlotsByDaypart(refresh, tz, daypart) : refresh).slice(0, 5);

          return {
            handled: true,
            reply: effectiveLang === "en"
              ? "That time just got taken. Here are the next available options:"
              : "Esa hora se acaba de ocupar. Aquí tienes las próximas opciones disponibles:",
            ctxPatch: {
              booking: { ...hydratedBooking, step: "offer_slots", timeZone: tz, slots: take, last_offered_date: ctxDate, date_only: ctxDate },
              booking_last_touch_at: Date.now(),
            },
          };
        }

        // ... sigue tu lógica normal
      }

      // ✅ Si existe EXACTO -> CONFIRM (opción B)
      if (exact) {
        const pretty = DateTime.fromISO(exact.startISO, { zone: tz })
        .setLocale(effectiveLang === "en" ? "en" : "es")
        .toFormat(effectiveLang === "en" ? "EEE, LLL dd 'at' h:mm a" : "ccc dd LLL, h:mm a");

        return {
          handled: true,
          reply: effectiveLang === "en"
            ? `Perfect, I have ${pretty}. Do you want to confirm? (yes/no)`
            : `Perfecto, tengo ${pretty}. ¿Confirmas ese horario? (sí/no)`,
          ctxPatch: {
            booking: {
              ...hydratedBooking,
              ...resetPersonal,
              step: "confirm",
              timeZone: tz,
              picked_start: exact.startISO,
              picked_end: exact.endISO,
              start_time: exact.startISO,
              end_time: exact.endISO,
              last_offered_date: ctxDate,
              date_only: ctxDate,
              slots: [], // ✅ sin lista
              },
            booking_last_touch_at: Date.now(),
          },
        };
      }

      // ✅ Si el PM candidate existe en los slots del día, úsalo para buscar cercanos
      const pmCandidate = candidates[1];
      const pmExists =
        !!pmCandidate &&
        allDaySlots.some(
          (s) => DateTime.fromISO(s.startISO, { zone: tz }).toFormat("HH:mm") === pmCandidate
        );

      const near = sortSlotsAsc(
        filterSlotsNearTime({
          slots: allDaySlots, // ✅ usa TODO el día
          timeZone: tz,
          hhmm: pmExists ? pmCandidate : candidates[0],
          windowMinutes: 180, // ±3h
          max: 5,
        })
      );

      const take = near.length ? near : allDaySlots.slice(0, 5);

      return {
        handled: true,
        reply: renderSlotsMessage({
          idioma: effectiveLang,
          timeZone: tz,
          slots: take,
          style: "closest",
          ask: "anything",
        }),
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
    
    // ✅ Solo interpretamos "número de opción" si NO hay hora explícita
    const hasExplicitTime = !!hhmmFixed || !!extractTimeConstraint(userText);

    // ✅ Solo interpretamos "número de opción" si NO hay hora explícita
    if (!hasExplicitTime) {
      const choice = parseSlotChoice(userText, slotsShown.length);

      if (!choice) {
        return {
        handled: true,
          reply:
            effectiveLang === "en"
            ? `Reply with a number (1-${slotsShown.length}). You can also say a time like "2pm" or "14:00".`
            : `Responde con un número (1-${slotsShown.length}). También puedes decir una hora como "2pm" o "14:00".`,
          ctxPatch: { booking: {...hydratedBooking}, booking_last_touch_at: Date.now() },
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
        slots: [],
        date_only: getCtxDateFromBookingOrSlots(slotsShown, hydratedBooking, tz),
        last_offered_date: getCtxDateFromBookingOrSlots(slotsShown, hydratedBooking, tz),
      };

      const whenTxt = formatSlotHuman({ startISO: picked.startISO, timeZone: tz, idioma: effectiveLang });

      const requirePhone = deps.canal === "facebook" || deps.canal === "instagram"; // IG/FB sí; WA normalmente no
      const missingName = !nextBooking?.name;
      const missingEmail = !nextBooking?.email;
      const missingPhone = requirePhone && !nextBooking?.phone;

      if (missingName || missingEmail || missingPhone) {
        return {
          handled: true,
          reply:
            effectiveLang === "en"
              ? `Perfect — I can do ${whenTxt}. Before I book it, send everything in ONE message: full name, email, and phone. Example: John Smith, john@email.com, +13055551234`
              : `Perfecto — puedo ${whenTxt}. Antes de agendarla, envíame todo en *un solo mensaje*: nombre completo, email y teléfono. Ej: Juan Pérez, juan@email.com, +13055551234`,
          ctxPatch: {
            booking: { ...nextBooking, step: "ask_all" },
            booking_last_touch_at: Date.now(),
          },
        };
      }

      // ✅ Ya tengo todo -> confirmar
      return {
        handled: true,
        reply:
          idioma === "en"
            ? `Perfect — to confirm ${whenTxt}, reply YES or NO.`
            : `Perfecto — para confirmar ${whenTxt}, responde SI o NO.`,
        ctxPatch: {
          booking: { ...nextBooking, step: "confirm" },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    // ✅ 2) Si el usuario pide "otras horas / otro horario / más tarde / más temprano"
    if (wantsMoreSlots(userText) && hours) {
      // intenta misma fecha si la tienes
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

        // Si el día tiene más opciones que las actuales, reemplaza por las del día
        if (allDaySlots.length) {
          return {
            handled: true,
            reply: renderSlotsMessage({ idioma: effectiveLang, timeZone: tz, slots: allDaySlots.slice(0, 5) }),
            ctxPatch: {
              booking: {
                ...hydratedBooking,
                step: "offer_slots",
                timeZone: tz,
                slots: allDaySlots.slice(0, 5),
                last_offered_date: ctxDate,
                date_only: ctxDate, },
              booking_last_touch_at: Date.now(),
            },
          };
        }
      }
    }
  
    // -----------------------------------------
    // Interpretar frases vagas ("después de las 4", etc.)
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
      hasHHMM(constraint) // ✅ aquí TS SÍ estrecha el tipo en este scope
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
  
    // ✅ Si no hubo slots cercanos, y tenemos hhmm, re-busca con ventana (OPCIÓN D real)
    if (hours && hasHHMM(constraint)) {
      
      // determina fecha contexto: date_only o last_offered_date o del primer slot
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
          const take = newSlots.slice(0, 5);
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
  
    // fallback si no se pudo re-buscar
    return {
      handled: true,
      reply: effectiveLang === "en"
        ? "I don’t see availability near that time. Would you like something earlier or later?"
        : "No veo disponibilidad cerca de esa hora. ¿Te sirve más temprano o más tarde?",
      ctxPatch: { booking: {...hydratedBooking}, booking_last_touch_at: Date.now() },
    };
  }
    // ✅ Fallback FINAL: garantiza return en todos los caminos (evita ts(2366))
    return {
      handled: true,
      reply:
        effectiveLang === "en"
          ? `Reply with a number (1-${slotsShown.length}). You can also say a time like "2pm" or "14:00".`
          : `Responde con un número (1-${slotsShown.length}). También puedes decir una hora como "2pm" o "14:00".`,
      ctxPatch: { booking: {...hydratedBooking}, booking_last_touch_at: Date.now() },
    };
}