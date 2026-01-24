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
} from "../text";

import {
  renderSlotsMessage,
  parseSlotChoice,
  filterSlotsByConstraint,
  filterSlotsNearTime,
  formatSlotHuman,
} from "../time";

import { getNextSlotsByDaypart, getSlotsForDate, getSlotsForDateWindow } from "../slots";

type Slot = { startISO: string; endISO: string };

export type OfferSlotsDeps = {
  tenantId: string;
  canal: string;
  contacto: string;
  idioma: "es" | "en";
  userText: string;

  booking: any;              // BookingCtx.booking
  timeZone: string;
  durationMin: number;
  bufferMin: number;
  hours: any | null;         // HoursByWeekday | null
};

function hasHHMM(c: any): c is { hhmm: string } {
  return typeof c?.hhmm === "string";
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
    hours,
  } = deps;

  const t = normalizeText(userText);
  const slots: Slot[] = Array.isArray(booking?.slots) ? booking.slots : [];
  
      if (!slots.length) {
        return {
          handled: true,
          reply: idioma === "en"
            ? "I don’t have available times saved for that date. Please send another date (YYYY-MM-DD)."
            : "No tengo horarios disponibles para esa fecha. Envíame otra fecha (YYYY-MM-DD).",
          ctxPatch: {
              booking: {
              ...booking,
                  step: "ask_datetime",
                  date_only: null,
                  slots: [],},
            booking_last_touch_at: Date.now(),
          },
        };
      }
  
      // 0) CAMBIO DE DÍA (antes que wantsMoreSlots)
      if (wantsAnotherDay(userText) && hours) {
        const tz = booking.timeZone || timeZone;
  
        const ctxDate =
          (booking as any)?.date_only ||
          (booking as any)?.last_offered_date ||
          (slots?.[0]?.startISO
            ? DateTime.fromISO(slots[0].startISO, { zone: tz }).toFormat("yyyy-MM-dd")
            : null);
  
        if (ctxDate) {
          // siguiente día
          const nextDate = DateTime.fromFormat(ctxDate, "yyyy-MM-dd", { zone: tz })
            .plus({ days: 1 })
            .toFormat("yyyy-MM-dd");
  
          const nextSlots = await getSlotsForDate({
            tenantId,
            timeZone: tz,
            dateISO: nextDate,
            durationMin,
            bufferMin,
            hours,
          });
  
          if (nextSlots.length) {
            return {
              handled: true,
              reply: renderSlotsMessage({ idioma, timeZone: tz, slots: nextSlots.slice(0, 5) }),
              ctxPatch: {
                booking: {
                  ...booking,
                  step: "offer_slots",
                  timeZone: tz,
                  slots: nextSlots.slice(0, 5),
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
          reply: idioma === "en"
            ? "I don’t see availability on the next day. Would you like to try a different date?"
            : "No veo disponibilidad para el próximo día. ¿Quieres que probemos otra fecha?",
          ctxPatch: { booking, booking_last_touch_at: Date.now() },
        };
      }
  
      // Si pregunta por horarios estando en offer_slots, simplemente re-muestra opciones
      if (/\b(horario|horarios|hours|available)\b/i.test(t)) {
  
      return {
          handled: true,
          reply: renderSlotsMessage({ idioma, timeZone: booking.timeZone || timeZone, slots }),
          ctxPatch: { 
              booking,
              booking_last_touch_at: Date.now(), 
          },
        };
      }
  
      // Ahora sí, cualquier otro cambio de tema
      if (wantsToChangeTopic(userText)) {
      return { handled: false, ctxPatch: { booking: { step: "idle" } } };
      }
  
    if (wantsToCancel(userText)) {
      return {
        handled: true,
        reply: idioma === "en"
          ? "No worries, whenever you’re ready to schedule, I’ll be here to help."
          : "No hay problema, cuando necesites agendar estaré aquí para ayudarte.",
        ctxPatch: { 
          booking: { step: "idle" },
          booking_last_touch_at: Date.now(),
        },
      };
    }
  
    // ✅ 1) Si el usuario pide una hora específica (ej: "5pm", "17:00", "a las 5")
    const hhmm = extractTimeOnlyToken(userText);
  
    if (hhmm) {
      const near = filterSlotsNearTime({
        slots,
        timeZone: booking.timeZone || timeZone,
        hhmm,
        windowMinutes: 150, // ±2.5h
        max: 5,
      });
  
      if (near.length) {
        return {
          handled: true,
          reply: renderSlotsMessage({ idioma, timeZone: booking.timeZone || timeZone, slots: near }),
          ctxPatch: {
            booking: {
              ...booking,
              step: "offer_slots",
              timeZone: booking.timeZone || timeZone,
              slots: near,
              // preserva la fecha contexto para que luego acepte "HH:mm" sin fecha
              last_offered_date: (booking as any)?.last_offered_date || null,},
            booking_last_touch_at: Date.now(),
          },
        };
      }
    }
  
    // ✅ 2) Si el usuario pide "otras horas / otro horario / más tarde / más temprano"
    if (wantsMoreSlots(userText) && hours) {
      // intenta misma fecha si la tienes
      const ctxDate =
        (booking as any)?.date_only ||
        (booking as any)?.last_offered_date ||
        (slots?.[0]?.startISO
          ? DateTime.fromISO(slots[0].startISO, { zone: booking.timeZone || timeZone }).toFormat("yyyy-MM-dd")
          : null);
  
      if (ctxDate) {
        const allDaySlots = await getSlotsForDate({
          tenantId,
          timeZone: booking.timeZone || timeZone,
          dateISO: ctxDate,
          durationMin,
          bufferMin,
          hours,
        });
  
        // Si el día tiene más opciones que las actuales, reemplaza por las del día
        if (allDaySlots.length) {
          return {
            handled: true,
            reply: renderSlotsMessage({ idioma, timeZone: booking.timeZone || timeZone, slots: allDaySlots.slice(0, 5) }),
            ctxPatch: {
              booking: {
                ...booking,
                step: "offer_slots",
                timeZone: booking.timeZone || timeZone,
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
  
      const dp = (booking as any)?.daypart || null;
  
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
      slots,
      timeZone: booking.timeZone || timeZone,
      constraint,
      max: 5,
    });
  
    if (filtered.length) {
      return {
        handled: true,
        reply: renderSlotsMessage({
          idioma,
          timeZone: booking.timeZone || timeZone,
          slots: filtered,
        }),
        ctxPatch: {
          booking: {
            ...booking,
            step: "offer_slots",
            timeZone: booking.timeZone || timeZone,
            slots: filtered,
          },
          booking_last_touch_at: Date.now(),
        },
      };
    }
  
    // ✅ Si no hubo slots cercanos, y tenemos hhmm, re-busca con ventana (OPCIÓN D real)
    if (hours && hasHHMM(constraint)) {
      const tz = booking.timeZone || timeZone;
  
      // determina fecha contexto: date_only o last_offered_date o del primer slot
      const ctxDate =
        (booking as any)?.date_only ||
        (booking as any)?.last_offered_date ||
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
  
        const newSlots = await getSlotsForDateWindow({
          tenantId,
          timeZone: tz,
          dateISO: ctxDate,
          durationMin,
          bufferMin,
          hours,
          windowStartHHmm,
          windowEndHHmm,
        });
  
        if (newSlots.length) {
          const take = newSlots.slice(0, 5);
          return {
            handled: true,
            reply: renderSlotsMessage({ idioma, timeZone: tz, slots: take }),
            ctxPatch: {
              booking: {
                ...booking,
                step: "offer_slots",
                timeZone: tz,
                slots: take,
                last_offered_date: ctxDate,
                date_only: ctxDate, // opcional, ayuda a aceptar "HH:mm" luego
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
      reply: idioma === "en"
        ? "I don’t see availability near that time. Would you like something earlier or later?"
        : "No veo disponibilidad cerca de esa hora. ¿Te sirve más temprano o más tarde?",
      ctxPatch: { booking, booking_last_touch_at: Date.now() },
    };
  }
  
  // ✅ Selección por número (1-5)
  const choice = parseSlotChoice(userText, slots.length);

  if (!choice) {
    return {
      handled: true,
      reply: idioma === "en"
        ? `Please, reply with a number (1-${slots.length}) or ask for another time (example: "5pm").`
        : `Por favor responde con un número (1-${slots.length}) o dime una hora (ej: "5pm" o "17:00").`,
      ctxPatch: { booking, booking_last_touch_at: Date.now() },
    };
  }

  const picked = slots[choice - 1];
  const whenTxt = formatSlotHuman({ startISO: picked.startISO, timeZone, idioma });

  return {
    handled: true,
    reply: idioma === "en"
      ? "Perfect. Please send your full name and email in ONE message (example: John Smith, john@email.com)."
      : "Perfecto. Envíame tu nombre completo y email en **un solo mensaje** (ej: Juan Pérez, juan@email.com).",
    ctxPatch: {
      booking: {
        ...booking,
        step: "ask_contact",
        picked_start: picked.startISO,
        picked_end: picked.endISO,
        slots: [],
        date_only: null,
      },
      booking_last_touch_at: Date.now(),
    },
  };
}