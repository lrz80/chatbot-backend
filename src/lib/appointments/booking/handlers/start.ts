// src/lib/appointments/booking/handlers/start.ts
import { DateTime } from "luxon";
import { buildDateTimeFromText, extractDateOnlyToken, extractTimeOnlyToken, extractTimeConstraint } from "../text";
import type { HoursByWeekday } from "../types";
import { weekdayKey, parseHHmm } from "../time";
import { getSlotsForDateWindow } from "../slots";
import { renderSlotsMessage } from "../time";
import { humanizeBookingReply } from "../humanizer";
import { googleFreeBusy } from "../../../../services/googleCalendar";
import { extractBusyBlocks } from "../freebusy";
import { cancelAppointmentById } from "../../cancelAppointment";
import { findActiveAppointmentsByPhone } from "../../find";
import pool from "../../../db";  // 👈 ruta desde handlers → booking → appointments → lib/db
import type { LangCode } from "../../../i18n/lang";
import { toCanonicalLangOrFallback } from "../../../i18n/lang";
import type { BookingPurpose } from "../signals/bookingSignals";

export type StartBookingDeps = {
  idioma: LangCode;
  userText: string;
  timeZone: string;
  canal: "whatsapp" | "facebook" | "instagram";
  contacto: string; // WhatsApp: phone, Meta: senderId

  wantsBooking: boolean;
  detectPurpose: (s: string) => BookingPurpose | null;
  wantsManageExisting: (s: string) => boolean;
  detectManageExistingAction: (s: string) => "cancel" | "reschedule" | null;

  durationMin: number;

  // ✅ opcionales (para no romper callers)
  minLeadMinutes?: number;
  hours?: HoursByWeekday | null;
  booking?: any; // ✅ ADD

  tenantId?: string;
  bufferMin?: number;
  getSlotsForDateWindow?: typeof getSlotsForDateWindow;
};

function renderPurposeLabel(
  purpose: BookingPurpose,
  lang: LangCode
): string {
  const isEs = lang === "es";

  switch (purpose) {
    case "appointment":
      return isEs ? "cita" : "appointment";
    case "class":
      return isEs ? "clase" : "class";
    case "consultation":
      return isEs ? "consulta" : "consultation";
    case "call":
      return isEs ? "llamada" : "call";
    case "visit":
      return isEs ? "visita" : "visit";
    case "demo":
      return "demo";
    default:
      return isEs ? "cita" : "appointment";
  }
}

export async function handleStartBooking(deps: StartBookingDeps): Promise<{
  handled: boolean;
  reply?: string;
  ctxPatch?: any;
}> {
    const {
      idioma,
      userText,
      timeZone,
      wantsBooking,
      detectPurpose,
      wantsManageExisting,
      detectManageExistingAction,
      durationMin,
      minLeadMinutes,
      hours,
      booking,
    } = deps;

  // ------------------------------------------------------------------
  // ✅ Gestionar cita ya creada: cancelar / reprogramar (post-booking)
  // Usa booking.last_appointment_id (lo guardas en confirm.ts)
  // ------------------------------------------------------------------
  const isMeta = deps.canal === "facebook" || deps.canal === "instagram";

  // Teléfono real del cliente según canal:
  // - WhatsApp: contacto ES el teléfono
  // - Meta: booking.phone (porque lo pides en ask_all)
  const customerPhone = isMeta
    ? String(deps.booking?.phone || "").trim()
    : String(deps.contacto || "").trim();

  // hay teléfono válido?
  const hasCustomerPhone = !!customerPhone && customerPhone.length >= 7;

  const manageExistingRequested = wantsManageExisting(userText);

  // 1) Si el usuario pide cancelar/reprogramar y tenemos una cita previa -> preguntar
  if (hasCustomerPhone && manageExistingRequested && deps.booking?.step !== "manage_existing") {
    const lang: LangCode = ((deps as any)?.booking?.lang as LangCode) || deps.idioma;

    if (!(deps as any)?.tenantId) {
      return {
        handled: true,
        reply:
          lang === "es"
            ? "Ahora mismo no puedo acceder al calendario. Intenta de nuevo."
            : "I can’t access scheduling right now. Please try again.",
        ctxPatch: { booking: { ...(deps as any).booking }, booking_last_touch_at: Date.now() },
      };
    }

    const appts = (await findActiveAppointmentsByPhone(deps.tenantId!, customerPhone)) ?? [];

    if (!appts.length) {
      return {
        handled: true,
        reply:
          lang === "es"
            ? "No encuentro una cita activa con este número. Si quieres, dime la nueva fecha y hora para agendar (YYYY-MM-DD HH:mm)."
            : "I can’t find an active appointment for this phone number. If you want, tell me the new date and time to book (YYYY-MM-DD HH:mm).",
        ctxPatch: { booking: { ...(deps as any).booking }, booking_last_touch_at: Date.now() },
      };
    }

    // Si hay 1 sola -> directo a menu cancelar/reprogramar
    if (appts.length === 1) {
      const apptId = String(appts[0].id);

      const msg =
        lang === "es"
          ? "Entiendo. ¿Qué deseas hacer?\n1) Cancelar la cita\n2) Reprogramarla\nResponde con 1 o 2."
          : "Got it. What would you like to do?\n1) Cancel the appointment\n2) Reschedule it\nReply with 1 or 2.";
         
      return {
        handled: true,
        reply: msg,
        ctxPatch: {
          booking: {
            ...(deps as any).booking,
            step: "manage_existing",
            manage_existing_appt_id: apptId,
          },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    // Si hay varias -> por ahora usa la más próxima (después hacemos selector)
    const apptId = String(appts[0].id);

    const msg =
      lang === "es"
        ? "Encontré más de una cita. Usaré la más próxima. ¿Qué deseas hacer?\n1) Cancelar\n2) Reprogramar\nResponde con 1 o 2."
        : "I found more than one appointment. I’ll use the next one. What would you like to do?\n1) Cancel\n2) Reschedule\nReply with 1 or 2.";
        
    return {
      handled: true,
      reply: msg,
      ctxPatch: {
        booking: {
          ...(deps as any).booking,
          step: "manage_existing",
          manage_existing_appt_id: apptId,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // 2) Si estamos en modo manage_existing -> procesar 1 o 2
  if ((deps as any)?.booking?.step === "manage_existing") {
    const lang: LangCode = ((deps as any)?.booking?.lang as LangCode) || deps.idioma;
    const apptId = String((deps as any)?.booking?.manage_existing_appt_id || "").trim();

    const raw = String(deps.userText || "").trim();
    const manageAction = detectManageExistingAction(raw);

    const chooseCancel = raw === "1" || manageAction === "cancel";
    const chooseReschedule = raw === "2" || manageAction === "reschedule";

    if (!apptId) {
      return {
        handled: true,
        reply:
          lang === "es"
            ? "No encuentro tu última cita. Envíame la fecha y hora para agendar (YYYY-MM-DD HH:mm)."
            : "I can’t find your last appointment. Please tell me the date/time you want to book (YYYY-MM-DD HH:mm).",
        ctxPatch: {
          booking: {
            ...(deps as any).booking,
            step: "ask_datetime",
          },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    // 2a) Cancelar
    if (chooseCancel) {
      const tenantId = (deps as any).tenantId;

      const out = await cancelAppointmentById({
        tenantId,
        appointmentId: apptId,
      });

      // ⬇️ Si algo falló (DB o Google), construimos un mensaje con teléfono del negocio
      if (!out.ok) {
        let businessPhone: string | null = null;

        try {
          const { rows } = await pool.query(
            `
            SELECT telefono_negocio
            FROM tenants
            WHERE id = $1
            LIMIT 1
            `,
            [tenantId]
          );
          businessPhone = rows[0]?.telefono_negocio || null;
        } catch (e) {
          console.warn("[BOOKING cancel] error leyendo telefono_negocio:", (e as any)?.message);
        }

        const replyError =
          lang === "es"
            ? businessPhone
              ? `No pude cancelarla en este momento. Por favor comunícate con nosotros al ${businessPhone}.`
              : "No pude cancelarla en este momento. Intenta de nuevo en unos segundos."
            : businessPhone
              ? `I couldn’t cancel it right now. Please contact us at ${businessPhone}.`
              : "I couldn’t cancel it right now. Please try again in a moment.";
           
        return {
          handled: true,
          reply: replyError,
          ctxPatch: {
            booking: {
              ...(deps as any).booking,
              step: "idle",
              manage_existing_appt_id: null,
            },
            booking_last_touch_at: Date.now(),
          },
        };
      }

      // ✅ Éxito: cancelada
      return {
        handled: true,
        reply:
          lang === "es"
            ? "Listo — tu cita quedó cancelada."
            : "Done — your appointment has been canceled.",
        ctxPatch: {
          booking: {
            ...(deps as any).booking,
            step: "idle",
            manage_existing_appt_id: null,
          },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    // 2b) Reprogramar -> arrancar ask_datetime y guardar de dónde venimos
    if (chooseReschedule) {
      return {
        handled: true,
        reply:
          lang === "es"
            ? "Perfecto — ¿qué nueva fecha y hora deseas? (YYYY-MM-DD HH:mm)"
            : "Sure — what new date and time would you like? (YYYY-MM-DD HH:mm)",
        ctxPatch: {
          booking: {
            ...(deps as any).booking,
            step: "ask_datetime",
            reschedule_from_appt_id: apptId,
            manage_existing_appt_id: null,
          },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    // 2c) Si no eligió bien
    return {
      handled: true,
      reply:
        lang === "es"
          ? "Responde con 1 para cancelar o 2 para reprogramar."
          : "Reply with 1 to cancel or 2 to reschedule.",
      ctxPatch: { booking: { ...(deps as any).booking }, booking_last_touch_at: Date.now() },
    };
  }

  const resolvedLang = toCanonicalLangOrFallback(
    (booking?.lang as LangCode) || idioma,
    "en"
  );

  const hydratedBooking = {
    ...(booking || {}),
    timeZone: booking?.timeZone || timeZone,
    lang: resolvedLang,
  };

  const effectiveLang: LangCode = resolvedLang;
  const tz = hydratedBooking.timeZone;

  async function isSlotReallyFree(startISO: string, endISO: string) {
    if (!deps.tenantId) return { ok: false, reason: "no_tenant" as const };
    if (!Number.isFinite(deps.bufferMin as any)) return { ok: false, reason: "no_buffer" as const };

    const start = DateTime.fromISO(startISO, { zone: tz });
    const end = DateTime.fromISO(endISO, { zone: tz });
    const timeMin = start.minus({ minutes: Number(deps.bufferMin) }).toISO();
    const timeMax = end.plus({ minutes: Number(deps.bufferMin) }).toISO();

    if (!timeMin || !timeMax) return { ok: false, reason: "invalid_range" as const };

    // ✅ usa el calendar_id real del tenant (si existe) + primary como fallback
    const calendarId = (deps as any)?.booking?.calendar_id || (deps as any)?.calendarId || null;

    const fb = await googleFreeBusy({
      tenantId: deps.tenantId,
      timeMin,
      timeMax,
      calendarIds: calendarId ? [calendarId, "primary"] : ["primary"],
    });

    if ((fb as any)?.degraded) return { ok: false, reason: "degraded" as const };

    const busy = extractBusyBlocks(fb);
    console.log("🧪 [SLOT REALLY FREE]", {
      tenantId: deps.tenantId,
      timeMin,
      timeMax,
      calendarIds: calendarId ? [calendarId, "primary"] : ["primary"],
      degraded: (fb as any)?.degraded ?? null,
      busyCount: busy.length,
    });

    return { ok: busy.length === 0, reason: busy.length ? "busy" as const : null };
  }

  async function pickClosestActuallyFreeSlots(target: DateTime, slots: any[], max = 3) {
    const sorted = [...slots].sort((a, b) => {
      const am = DateTime.fromISO(a.startISO, { zone: tz }).toMillis();
      const bm = DateTime.fromISO(b.startISO, { zone: tz }).toMillis();
      const t = target.toMillis();
      return Math.abs(am - t) - Math.abs(bm - t);
    });

    const out: any[] = [];
    for (const s of sorted) {
      if (out.length >= max) break;
      const ok = await isSlotReallyFree(s.startISO, s.endISO);
      if (ok.ok) out.push(s);
    }
    return out;
  }

  async function findFreeSlotsForDay(dateISO: string, target: DateTime, max = 3) {
    if (!deps.getSlotsForDateWindow || !deps.tenantId || typeof deps.bufferMin !== "number" || !hours) return [];

    const day = DateTime.fromFormat(dateISO, "yyyy-MM-dd", { zone: tz });
    const key = weekdayKey(day);
    const bh = hours[key];
    if (!bh?.start || !bh?.end) return [];

    const slots = await deps.getSlotsForDateWindow({
      tenantId: deps.tenantId,
      timeZone: tz,
      dateISO,
      durationMin,
      bufferMin: deps.bufferMin,
      hours,
      windowStartHHmm: bh.start,
      windowEndHHmm: bh.end,
      minLeadMinutes: deps.minLeadMinutes || 0,
    });

    if (!slots?.length) return [];
    return pickClosestActuallyFreeSlots(target, slots, max);
  }

  async function findNextDayWithAvailability(fromDateISO: string, target: DateTime, maxDays = 14, max = 3) {
    const startDay = DateTime.fromFormat(fromDateISO, "yyyy-MM-dd", { zone: tz });
    if (!startDay.isValid) return null;

    for (let i = 1; i <= maxDays; i++) {
      const d = startDay.plus({ days: i });
      const key = weekdayKey(d);

      // salta días cerrados (sat/sun null etc.)
      if (!hours?.[key]?.start || !hours?.[key]?.end) continue;

      const dateISO = d.toFormat("yyyy-MM-dd");

      // target para ordenar cercanía: mismo “HH:mm” que pidió el user, pero ese día
      const t = d.set({
        hour: target.hour,
        minute: target.minute,
        second: 0,
        millisecond: 0,
      });

      const take = await findFreeSlotsForDay(dateISO, t, max);
      if (take.length) return { dateISO, take };
    }

    return null;
  }

  if (!wantsBooking) return { handled: false };

  const resetPersonal = {
    name: null,
    email: null,
    phone: hydratedBooking.phone || null,
  };

  // ✅ NUEVO: si el usuario ya dijo día+hora ("lunes a las 3") -> confirm directo
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
    const canonicalText =
      effectiveLang === "es"
            ? "Lo siento! Ese horario no está disponible. ¿Qué otra hora te funciona?"
            : "I'm sorry! That time is not available. What other time works for you?";

      const humanReply = await humanizeBookingReply({
        idioma: effectiveLang,
        intent: "ask_other_time",
        askedText: userText,
        canonicalText,
        locked: [], // nada sensible aquí
      });

      return {
        handled: true,
        reply: humanReply,
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

    const base = DateTime.fromFormat(dateISO2, "yyyy-MM-dd", { zone: tz }).set({
      hour: h,
      minute: m,
      second: 0,
      millisecond: 0,
    });

    const windowStartHHmm = base.minus({ hours: 2 }).toFormat("HH:mm");
    const windowEndHHmm = base.plus({ hours: 3 }).toFormat("HH:mm");

    // ✅ helper único: día completo -> next day -> ask_date
    const replySameDayOrNext = async () => {
      const anySameDay = await findFreeSlotsForDay(dateISO2, base, 3);

      if (anySameDay.length) {
        const optionsText = renderSlotsMessage({
          idioma: effectiveLang,
          timeZone: tz,
          slots: anySameDay,
          style: "closest",
        });

        const canonicalText =
          effectiveLang === "es"
            ? `Ese horario no está disponible. Aquí tienes otras horas disponibles ese día:\n\n${optionsText}`
            : `That time isn't available. Here are other available times that day:\n\n${optionsText}`;

        const humanReply = await humanizeBookingReply({
          idioma: effectiveLang,
          intent: "slot_exact_unavailable_with_options",
          askedText: userText,
          canonicalText,
          optionsText,
          locked: [optionsText],
        });

        return {
          handled: true,
          reply: humanReply,
          ctxPatch: {
            booking: {
              ...(hydratedBooking || {}),
              ...resetPersonal,
              step: "offer_slots",
              timeZone: tz,
              lang: effectiveLang,
              date_only: dateISO2,
              last_offered_date: dateISO2,
              slots: anySameDay,
            },
            booking_last_touch_at: Date.now(),
          },
        };
      }

      const next = await findNextDayWithAvailability(dateISO2, base, 14, 3);
      if (next?.take?.length) {
        const optionsText = renderSlotsMessage({
          idioma: effectiveLang,
          timeZone: tz,
          slots: next.take,
          style: "sameDay", // ✅ antes: "closest"
        });

        const prettyDay =
          effectiveLang === "es"
            ? DateTime.fromFormat(next.dateISO, "yyyy-MM-dd", { zone: tz }).setLocale("es").toFormat("cccc d 'de' LLL")
            : DateTime.fromFormat(next.dateISO, "yyyy-MM-dd", { zone: tz }).setLocale("en").toFormat("cccc, LLL d");

        const canonicalText =
          effectiveLang === "es"
            ? `Ese día no tengo disponibilidad. El próximo día disponible es ${prettyDay}.\n\n${optionsText}`
            : `I’m fully booked that day. The next available day is ${prettyDay}.\n\n${optionsText}`;

        const humanReply = await humanizeBookingReply({
          idioma: effectiveLang,
          intent: "offer_slots_for_date",
          askedText: userText,
          canonicalText,
          optionsText,
          locked: [optionsText, prettyDay],
          datePrefix: `${prettyDay}: `,
        });

        return {
          handled: true,
          reply: humanReply,
          ctxPatch: {
            booking: {
              ...(hydratedBooking || {}),
              ...resetPersonal,
              step: "offer_slots",
              timeZone: tz,
              lang: effectiveLang,
              date_only: next.dateISO,
              last_offered_date: next.dateISO,
              slots: next.take,
            },
            booking_last_touch_at: Date.now(),
          },
        };
      }

      const canonicalText =
        effectiveLang === "es"
          ? "No veo disponibilidad en los próximos días. ¿Qué otra fecha te funciona?"
          : "I don’t see availability in the next days. What other date works for you?";

      const humanReply = await humanizeBookingReply({
        idioma: effectiveLang,
        intent: "no_openings_that_day",
        askedText: userText,
        canonicalText,
        locked: [],
      });

      return {
        handled: true,
        reply: humanReply,
        ctxPatch: {
          booking: { ...(hydratedBooking || {}), step: "ask_date", timeZone: tz, lang: effectiveLang },
          booking_last_touch_at: Date.now(),
        },
      };
    };

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

    // ✅ si no hay slots en ventana: cae al helper (día/next/ask_date)
    if (!windowSlots?.length) {
      return await replySameDayOrNext();
    }

    // desde aquí: ya hay slots
    const exact = windowSlots.find((s) => {
      const start = DateTime.fromISO(s.startISO, { zone: tz }).toFormat("HH:mm");
      return start === hhmm;
    });

    // ✅ Si el exact está en windowSlots, igual revalida "real"
    if (exact) {
      const check = await isSlotReallyFree(exact.startISO, exact.endISO);

      // busy -> 3 cercanos realmente libres; si no hay -> helper día/next/ask_date
      if (!check.ok && check.reason === "busy") {
        const take = await pickClosestActuallyFreeSlots(base, windowSlots, 3);

        if (take.length) {
          const optionsText = renderSlotsMessage({ idioma: effectiveLang, timeZone: tz, slots: take, style: "closest" });

          const canonicalText =
            effectiveLang === "es"
              ? `Lo siento, esa hora no está disponible. Tengo estas horas disponibles:\n\n${optionsText}`
              : `Sorry, that time isn't available. I have these times available:\n\n${optionsText}`;

          const humanReply = await humanizeBookingReply({
            idioma: effectiveLang,
            intent: "slot_exact_unavailable_with_options",
            askedText: userText,
            canonicalText,
            optionsText,
            locked: [optionsText],
          });

          return {
            handled: true,
            reply: humanReply,
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

        return await replySameDayOrNext();
      }

      // degraded/no_tenant/no_buffer/etc -> NO confirmes, ofrece 3 cercanos del windowSlots; si no hay -> ask_other_time
      if (!check.ok) {
        const take = [...windowSlots]
          .sort((a, b) => {
            const am = DateTime.fromISO(a.startISO, { zone: tz }).toMillis();
            const bm = DateTime.fromISO(b.startISO, { zone: tz }).toMillis();
            const t = base.toMillis();
            return Math.abs(am - t) - Math.abs(bm - t);
          })
          .slice(0, 3);

        if (take.length) {
          const optionsText = renderSlotsMessage({ idioma: effectiveLang, timeZone: tz, slots: take, style: "closest" });

          const canonicalText =
            effectiveLang === "es"
              ? `Lo siento, esa hora no está disponible. Tengo estas horas disponibles:\n\n${optionsText}`
              : `Sorry, that time isn't available. I have these times available:\n\n${optionsText}`;
 
          const humanReply = await humanizeBookingReply({
            idioma: effectiveLang,
            intent: "slot_exact_unavailable_with_options",
            askedText: userText,
            canonicalText,
            optionsText,
            locked: [optionsText],
          });

          return {
            handled: true,
            reply: humanReply,
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

        const canonicalText =
          effectiveLang === "es"
            ? "Lo siento, esa hora no está disponible. ¿Qué otra hora te funciona?"
            : "Sorry, that time isn't available. What other time works for you?";

        const humanReply = await humanizeBookingReply({
          idioma: effectiveLang,
          intent: "ask_other_time",
          askedText: userText,
          canonicalText,
          locked: [],
        });

        return {
          handled: true,
          reply: humanReply,
          ctxPatch: {
            booking: { ...(hydratedBooking || {}), step: "ask_datetime", timeZone: tz, lang: effectiveLang },
            booking_last_touch_at: Date.now(),
          },
        };
      }

      // ✅ confirmado
      const prettyWhen =
        effectiveLang === "es"
          ? DateTime.fromISO(exact.startISO, { zone: tz }).setLocale("es").toFormat("cccc d 'de' LLL 'a las' h:mm a")
          : DateTime.fromISO(exact.startISO, { zone: tz }).setLocale("en").toFormat("cccc, LLL d 'at' h:mm a");
          
      const canonicalText =
        effectiveLang === "es"
          ? `Perfecto — tengo ${prettyWhen}. ¿La reservo?`
          : `Perfect — I do have ${prettyWhen}. Confirm?`;
 
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

    // ❌ no hay exact: intenta 3 realmente libres; si no hay -> helper día/next/ask_date
    const take = await pickClosestActuallyFreeSlots(base, windowSlots, 3);

    if (!take.length) {
      return await replySameDayOrNext();
    }

    const optionsText = renderSlotsMessage({
      idioma: effectiveLang,
      timeZone: tz,
      slots: take,
      style: "closest",
    });

    const canonicalText =
      effectiveLang === "es"
        ? `Lo siento, esa hora no está disponible. Tengo estas horas disponibles:\n\n${optionsText}`
        : `Sorry, that time isn’t available. I have these times available:\n\n${optionsText}`;
        
    const humanReply = await humanizeBookingReply({
      idioma: effectiveLang,
      intent: "slot_exact_unavailable_with_options",
      askedText: userText,
      canonicalText,
      optionsText,
      locked: [optionsText],
    });

    return {
      handled: true,
      reply: humanReply,
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

  if (dt) {
    const d = DateTime.fromISO(dt.startISO, { zone: tz }).setLocale(effectiveLang === "en" ? "en" : "es");

    // ✅ Guard: check real con Google (si no podemos chequear, NO confirmes)
    const check = await isSlotReallyFree(dt.startISO, dt.endISO);

    if (!check.ok && check.reason === "busy" && deps.getSlotsForDateWindow && deps.tenantId && typeof deps.bufferMin === "number" && hours) {
      const target = DateTime.fromISO(dt.startISO, { zone: tz });

      const dateISO3 = target.toFormat("yyyy-MM-dd");
      const windowStartHHmm = target.minus({ hours: 2 }).toFormat("HH:mm");
      const windowEndHHmm = target.plus({ hours: 3 }).toFormat("HH:mm");

      const windowSlots = await deps.getSlotsForDateWindow({
        tenantId: deps.tenantId,
        timeZone: tz,
        dateISO: dateISO3,
        durationMin,
        bufferMin: deps.bufferMin,
        hours,
        windowStartHHmm,
        windowEndHHmm,
        minLeadMinutes: deps.minLeadMinutes || 0,
      });

      const take = await pickClosestActuallyFreeSlots(target, windowSlots || [], 3);

      if (take.length) {
        const optionsText = renderSlotsMessage({
          idioma: effectiveLang,
          timeZone: tz,
          slots: take,
          style: "sameDay", // ✅ antes: "closest"
        });

        const canonicalText =
          effectiveLang === "es"
            ? `Lo siento, esa hora no está disponible.\n\n${optionsText}`
            : `Sorry, that time isn't available.\n\n${optionsText}`;
     
        const humanReply = await humanizeBookingReply({
          idioma: effectiveLang,
          intent: "slot_exact_unavailable_with_options",
          askedText: userText,
          canonicalText,
          optionsText,
          locked: [optionsText],
        });

        return {
          handled: true,
          reply: humanReply,
          ctxPatch: {
            booking: {
              ...(hydratedBooking || {}),
              ...resetPersonal,
              step: "offer_slots",
              timeZone: tz,
              lang: effectiveLang,
              date_only: dateISO3,
              last_offered_date: dateISO3,
              slots: take,
            },
            booking_last_touch_at: Date.now(),
          },
        };
      }

      // ✅ Día completo: intenta 3 opciones en ese mismo día (9-5)
      const anySameDay = await findFreeSlotsForDay(dateISO3, target, 3);
      if (anySameDay.length) {
        const optionsText = renderSlotsMessage({ idioma: effectiveLang, timeZone: tz, slots: anySameDay, style: "closest" });
        const canonicalText =
          effectiveLang === "es"
            ? `Ese horario no está disponible. Aquí tienes otras horas disponibles ese día:\n\n${optionsText}`
            : `That time isn't available. Here are other available times that day:\n\n${optionsText}`;
  
        const humanReply = await humanizeBookingReply({
          idioma: effectiveLang,
          intent: "slot_exact_unavailable_with_options",
          askedText: userText,
          canonicalText,
          optionsText,
          locked: [optionsText],
        });

        return {
          handled: true,
          reply: humanReply,
          ctxPatch: {
            booking: { ...(hydratedBooking || {}), ...resetPersonal, step: "offer_slots", timeZone: tz, lang: effectiveLang, date_only: dateISO3, last_offered_date: dateISO3, slots: anySameDay },
            booking_last_touch_at: Date.now(),
          },
        };
      }

      // ✅ Next day con disponibilidad
      const next = await findNextDayWithAvailability(dateISO3, target, 14, 3);
      if (next?.take?.length) {
        const optionsText = renderSlotsMessage({ idioma: effectiveLang, timeZone: tz, slots: next.take, style: "closest" });

        const prettyDay =
          effectiveLang === "es"
            ? DateTime.fromFormat(next.dateISO, "yyyy-MM-dd", { zone: tz }).setLocale("es").toFormat("cccc d 'de' LLL")
            : DateTime.fromFormat(next.dateISO, "yyyy-MM-dd", { zone: tz }).setLocale("en").toFormat("cccc, LLL d");
            
        const canonicalText =
          effectiveLang === "es"
            ? `Ese día no tengo disponibilidad. El próximo día disponible es ${prettyDay}. Aquí tienes algunas opciones:\n\n${optionsText}`
            : `I’m fully booked that day. The next available day is ${prettyDay}. Here are a few options:\n\n${optionsText}`;
           
        const humanReply = await humanizeBookingReply({
          idioma: effectiveLang,
          intent: "offer_slots_for_date",
          askedText: userText,
          canonicalText,
          optionsText,
          locked: [optionsText, prettyDay],
          datePrefix: `${prettyDay}: `,
        });

        return {
          handled: true,
          reply: humanReply,
          ctxPatch: {
            booking: { ...(hydratedBooking || {}), ...resetPersonal, step: "offer_slots", timeZone: tz, lang: effectiveLang, date_only: next.dateISO, last_offered_date: next.dateISO, slots: next.take },
            booking_last_touch_at: Date.now(),
          },
        };
      }
    }

    // si no es busy o no tenemos slots para sugerir:
    if (!check.ok) {
      const canonicalText =
        effectiveLang === "es"
          ? "Ese horario no está disponible. ¿Qué otra hora te funciona?"
          : "That time isn't available. What other time works for you?";
   
      const humanReply = await humanizeBookingReply({
        idioma: effectiveLang,
        intent: "ask_other_time",
        askedText: userText,
        canonicalText,
        locked: [],
      });

      return {
        handled: true,
        reply: humanReply,
        ctxPatch: {
          booking: { ...(hydratedBooking || {}), step: "ask_datetime", timeZone: tz, lang: effectiveLang },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    const prettyWhen =
      effectiveLang === "es"
        ? d.toFormat("cccc d 'de' LLL 'a las' h:mm a")
        : d.toFormat("cccc, LLL d 'at' h:mm a");
       
    const canonicalText =
      effectiveLang === "es"
        ? `Perfecto — tengo ${prettyWhen}. ¿Confirmas?`
        : `Perfect — I do have ${prettyWhen}. Confirm?`;
     
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
    const canonicalText =
      effectiveLang === "es"
        ? "¡Claro! ¿Qué te gustaría agendar? (cita, clase, consulta o llamada)"
        : "Sure — what would you like to schedule? (appointment, class, consultation, or a call)";
     
    const humanReply = await humanizeBookingReply({
      idioma: effectiveLang,
      intent: "ask_purpose",
      askedText: userText,
      canonicalText,
      locked: [],
    });

    return {
      handled: true,
      reply: humanReply,
      ctxPatch: {
        booking: { ...(booking || {}), step: "ask_purpose", timeZone: tz, lang: effectiveLang },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // 2) Con propósito -> pregunta daypart
  const purposeLabel = renderPurposeLabel(purpose, effectiveLang);

  const canonicalText =
    effectiveLang === "es"
      ? `Perfecto — para ${purposeLabel}, ¿te funciona mejor en la mañana o en la tarde?`
      : `Got it — for ${purposeLabel}, do mornings or afternoons work better?`;
    
  const humanReply = await humanizeBookingReply({
    idioma: effectiveLang,
    intent: "ask_daypart",
    askedText: userText,
    canonicalText,
    locked: [purposeLabel],
    purpose,
  });

  return {
    handled: true,
    reply: humanReply,
    ctxPatch: {
      booking: { ...(booking || {}), step: "ask_daypart", timeZone: tz, purpose, lang: effectiveLang },
      booking_last_touch_at: Date.now(),
    },
  };
}
