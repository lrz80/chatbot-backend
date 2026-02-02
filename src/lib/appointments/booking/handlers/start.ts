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

  async function isSlotReallyFree(startISO: string, endISO: string) {
    if (!deps.tenantId) return { ok: false, reason: "no_tenant" as const };
    if (!Number.isFinite(deps.bufferMin as any)) return { ok: false, reason: "no_buffer" as const };

    const start = DateTime.fromISO(startISO, { zone: tz });
    const end = DateTime.fromISO(endISO, { zone: tz });
    const timeMin = start.minus({ minutes: Number(deps.bufferMin) }).toISO();
    const timeMax = end.plus({ minutes: Number(deps.bufferMin) }).toISO();

    if (!timeMin || !timeMax) return { ok: false, reason: "invalid_range" as const };

    const fb = await googleFreeBusy({
      tenantId: deps.tenantId,
      timeMin,
      timeMax,
      calendarIds: ["primary"], // por ahora. En el paso siguiente lo cambiamos al calendar_id real del tenant.
    });

    if ((fb as any)?.degraded) return { ok: false, reason: "degraded" as const };

    const busy = extractBusyBlocks(fb);
    console.log("🧪 [SLOT REALLY FREE]", {
      tenantId: deps.tenantId,
      timeMin,
      timeMax,
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
      effectiveLang === "en"
            ? "I'm sorry! That time is not available. What other time works for you?"
            : "Lo siento! Ese horario no está disponible. ¿Qué otra hora te funciona?";

      const humanReply = await humanizeBookingReply({
        idioma: effectiveLang,
        intent: "ask_daypart_retry",
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
        // ✅ Guard: check real con Google
        const check = await isSlotReallyFree(exact.startISO, exact.endISO);

        // ✅ si está ocupado -> ofrecer 3 cercanos REALMENTE libres
        if (!check.ok && check.reason === "busy") {
          const take = await pickClosestActuallyFreeSlots(base, windowSlots, 3);

          if (take.length > 0) {
            const optionsText = renderSlotsMessage({
              idioma: effectiveLang,
              timeZone: tz,
              slots: take,
              style: "closest",
            });

            const canonicalText =
              effectiveLang === "en"
                ? `Sorry, that time isn't available. I have these times available:\n\n${optionsText}`
                : `Lo siento, esa hora no está disponible. Tengo estas horas disponibles:\n\n${optionsText}`;

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

          // no conseguimos opciones libres
          const canonicalText =
            effectiveLang === "en"
              ? "Sorry, that time isn't available. What other time works for you?"
              : "Lo siento, esa hora no está disponible. ¿Qué otra hora te funciona?";

          const humanReply = await humanizeBookingReply({
            idioma: effectiveLang,
            intent: "ask_daypart_retry",
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

        // ✅ Si NO está libre (busy / degraded / lo que sea), NO digas "no puedo confirmar".
        // En vez de eso, ofrece 3 slots cercanos del windowSlots.
        if (!check.ok) {
          // intenta dar 3 opciones cercanas (windowSlots ya viene filtrado por freebusy + buffer en tu motor)
          const take = [...windowSlots]
            .sort((a, b) => {
              const am = DateTime.fromISO(a.startISO, { zone: tz }).toMillis();
              const bm = DateTime.fromISO(b.startISO, { zone: tz }).toMillis();
              const t = base.toMillis();
              return Math.abs(am - t) - Math.abs(bm - t);
            })
            .slice(0, 3);

          if (take.length) {
            const optionsText = renderSlotsMessage({
              idioma: effectiveLang,
              timeZone: tz,
              slots: take,
              style: "closest",
            });

            const canonicalText =
              effectiveLang === "en"
                ? `Sorry, that time isn't available. I have these times available:\n\n${optionsText}`
                : `Lo siento, esa hora no está disponible. Tengo estas horas disponibles:\n\n${optionsText}`;

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

          // si por alguna razón no tenemos slots, entonces sí pedimos otra hora
          const canonicalText =
            effectiveLang === "en"
              ? "Sorry, that time isn't available. What other time works for you?"
              : "Lo siento, esa hora no está disponible. ¿Qué otra hora te funciona?";

          const humanReply = await humanizeBookingReply({
            idioma: effectiveLang,
            intent: "ask_daypart_retry",
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

        // ✅ Exacto disponible -> confirm directo
        const prettyWhen =
          effectiveLang === "en"
            ? DateTime.fromISO(exact.startISO, { zone: tz }).setLocale("en").toFormat("cccc, LLL d 'at' h:mm a")
            : DateTime.fromISO(exact.startISO, { zone: tz }).setLocale("es").toFormat("cccc d 'de' LLL 'a las' h:mm a");

        const canonicalText =
          effectiveLang === "en"
            ? `Perfect I do have ${prettyWhen}. Confirm?`
            : `Perfecto tengo ${prettyWhen}. disponible. ¿La reservo?`;

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

      // ❌ No hay exacto -> ofrecer 3 cercanos realmente libres
      const take = await pickClosestActuallyFreeSlots(base, windowSlots, 3);

      // ⚠️ Si no hay ninguna hora realmente libre → fallback
      if (!take.length) {
        const canonicalText =
          effectiveLang === "en"
            ? "Sorry — I don’t have availability around that time. What other time works for you?"
            : "Lo siento — no tengo disponibilidad cerca de esa hora. ¿Qué otra hora te funciona?";

        const humanReply = await humanizeBookingReply({
          idioma: effectiveLang,
          intent: "ask_daypart_retry",
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

      const optionsText = renderSlotsMessage({
        idioma: effectiveLang,
        timeZone: tz,
        slots: take,
        style: "closest",
      });

      const canonicalText =
        effectiveLang === "en"
          ? `Sorry, that time isn’t available. I have these times available:\n\n${optionsText}`
          : `Lo siento, esa hora no está disponible. Tengo estas horas disponibles:\n\n${optionsText}`;

      const humanReply = await humanizeBookingReply({
        idioma: effectiveLang,
        intent: "slot_exact_unavailable_with_options",
        askedText: userText,
        canonicalText,
        optionsText,
        locked: [optionsText], // asegura que no invente horarios
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
          style: "closest",
        });

        const canonicalText =
          effectiveLang === "en"
            ? `Sorry, that time isn't available. I have these times available:\n\n${optionsText}`
            : `Lo siento, esa hora no está disponible. Tengo estas horas disponibles:\n\n${optionsText}`;

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
    }

    // si no es busy o no tenemos slots para sugerir:
    if (!check.ok) {
      const canonicalText =
        effectiveLang === "en"
          ? "I can’t confirm that time right now. What other time works for you?"
          : "Ahora mismo no puedo confirmar ese horario en el calendario. ¿Qué otra hora te funciona?";

      const humanReply = await humanizeBookingReply({
        idioma: effectiveLang,
        intent: "ask_daypart_retry",
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
      effectiveLang === "en"
        ? d.toFormat("cccc, LLL d 'at' h:mm a")
        : d.toFormat("cccc d 'de' LLL 'a las' h:mm a");

    const canonicalText =
      effectiveLang === "en"
        ? `Perfect — I do have ${prettyWhen}. Confirm?`
        : `Perfecto — tengo ${prettyWhen}. ¿Confirmas?`;

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
      effectiveLang === "en"
        ? "Sure — what would you like to schedule? (appointment, class, consultation, or a call)"
        : "¡Claro! ¿Qué te gustaría agendar? (cita, clase, consulta o llamada)";

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
  const canonicalText =
    effectiveLang === "en"
      ? `Got it — for ${purpose}, do mornings or afternoons work better?`
      : `Perfecto — para ${purpose}, ¿te funciona mejor en la mañana o en la tarde?`;

  const humanReply = await humanizeBookingReply({
    idioma: effectiveLang,
    intent: "ask_daypart",
    askedText: userText,
    canonicalText,
    locked: [purpose], // ✅ no es crítico, pero ayuda a que no lo cambie
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
