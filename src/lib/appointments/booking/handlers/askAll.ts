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
  durationMin: number,
  minLeadMinutes: number
) => any;

export type AskAllDeps = {
  tenantId: string;
  canal: string;
  idioma: "es" | "en";
  userText: string;

  booking: any; // BookingCtx.booking
  timeZone: string;
  durationMin: number;
  bufferMin: number;
  hours: any | null; // HoursByWeekday | null

  parseDateTimeExplicit: ParseDateTimeExplicitFn;
  minLeadMinutes: number; 
};

export async function handleAskAll(deps: AskAllDeps): Promise<{
  handled: boolean;
  reply?: string;
  ctxPatch?: any;
}> {
  const {
    tenantId,
    canal,
    idioma,
    userText,
    booking,
    timeZone,
    durationMin,
    bufferMin,
    hours,
    minLeadMinutes,
    parseDateTimeExplicit,
  } = deps;

  const isMeta = canal === "facebook" || canal === "instagram";
  // ✅ Hydrate: preservar slot elegido aunque venga en picked_*
  const hydratedBooking = {
    ...booking,
    timeZone: booking?.timeZone || timeZone, // ✅ sticky
    lang: booking?.lang || idioma,           // ✅ sticky
    start_time: booking?.start_time || booking?.picked_start || null,
    end_time: booking?.end_time || booking?.picked_end || null,
    phone: booking?.phone || null,
    name: booking?.name || null,
    email: booking?.email || null,
    purpose: booking?.purpose || null,
    date_only: booking?.date_only || null,
    last_offered_date: booking?.last_offered_date || null,
    slots: booking?.slots || [],
  };

  const effectiveLang: "es" | "en" = (hydratedBooking.lang as any) || idioma;
  const tz = hydratedBooking.timeZone; // ✅ single source of truth

  const hasChosenSlot = !!hydratedBooking.start_time && !!hydratedBooking.end_time;

  if (wantsToChangeTopic(userText)) {
    return { handled: false, ctxPatch: { booking: { ...hydratedBooking, step: "idle", lang: effectiveLang, } } };
  }

  if (wantsToCancel(userText)) {
    return {
      handled: true,
      reply:
        effectiveLang === "en"
          ? "Of course, no problem. I’ll stop the process for now. Whenever you’re ready, just tell me."
          : "Claro, no hay problema. Detengo todo por ahora. Cuando estés listo, solo avísame.",
      ctxPatch: {
        booking: {
          ...hydratedBooking,
          step: "idle",
          lang: effectiveLang,
          start_time: null,
          end_time: null,
          timeZone: tz,
          name: null,
          email: null,
          purpose: null,
          date_only: null,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  const parsed = parseAllInOne(userText, tz, durationMin, minLeadMinutes, parseDateTimeExplicit);

  // ✅ Merge: lo que llega del usuario + lo que ya teníamos
  const name = (parsed?.name || hydratedBooking?.name || "").trim() || null;
  const email = (parsed?.email || hydratedBooking?.email || "").trim() || null;

  // phone solo aplica a Meta (IG/FB). En WhatsApp no lo pedimos aquí.
  const phone =
    isMeta
      ? ((parsed?.phone || hydratedBooking?.phone || "").trim() || null)
      : (hydratedBooking?.phone || null);

  // ✅ Si vino fecha/hora pero era en el pasado, dilo explícitamente
  const dtToken = extractDateTimeToken(userText);
  if (dtToken) {
    const chk: any = parseDateTimeExplicit(dtToken, tz, durationMin, minLeadMinutes);
    if (chk?.error === "PAST_SLOT") {
      return {
        handled: true,
        reply:
          effectiveLang === "en"
            ? "That date/time is in the past. Please send a future date and time (YYYY-MM-DD HH:mm)."
            : "Esa fecha/hora ya pasó. Envíame una fecha y hora futura (YYYY-MM-DD HH:mm).",
        ctxPatch: {
          booking: {
            ...hydratedBooking,
            step: "ask_datetime",
            lang: effectiveLang,
            timeZone: tz,
            name: parsed?.name || hydratedBooking?.name || null,
            email: parsed?.email || hydratedBooking?.email || null,
            date_only: null,
          },
          booking_last_touch_at: Date.now(),
        },
      };
    }
  }

  // ✅ Caso: el usuario manda SOLO fecha (YYYY-MM-DD) + name/email pero sin hora
  const dateOnly = extractDateOnlyToken(userText, tz);
  if (dateOnly && parsed?.name && parsed?.email && !parsed?.startISO) {
    // bloquea fecha pasada
    const dateOnlyDt = DateTime.fromFormat(dateOnly, "yyyy-MM-dd", { zone: tz });
    const todayStart = DateTime.now().setZone(tz).startOf("day");
    if (dateOnlyDt.isValid && dateOnlyDt < todayStart) {
      return {
        handled: true,
        reply:
          effectiveLang === "en"
            ? "That date is in the past. Please send a future date (YYYY-MM-DD)."
            : "Esa fecha ya pasó. Envíame una fecha futura (YYYY-MM-DD).",
        ctxPatch: {
          booking: {
            ...hydratedBooking,
            step: "ask_datetime",
            lang: effectiveLang,
            timeZone: tz,
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
          effectiveLang === "en"
            ? `Got it — what time works for you on ${dateOnly}? Reply with HH:mm (example: 14:00).`
            : `Perfecto — ¿a qué hora te gustaría el ${dateOnly}? Respóndeme con HH:mm (ej: 14:00).`,
        ctxPatch: {
          booking: {
            ...hydratedBooking,
            step: "ask_datetime",
            lang: effectiveLang,
            timeZone: tz,
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
      timeZone: tz,
      dateISO: dateOnly,
      durationMin,
      bufferMin,
      hours,
      minLeadMinutes,
    });

    const take = (slots || []).slice(0, 5);

    return {
      handled: true,
      reply: renderSlotsMessage({ idioma: effectiveLang, timeZone: tz, slots: take }),
      ctxPatch: {
        booking: {
          ...hydratedBooking,
          step: "offer_slots",
          lang: effectiveLang,
          timeZone: tz,
          name: parsed.name,
          email: parsed.email,
          purpose: hydratedBooking?.purpose || null,
          date_only: dateOnly,
          slots: take,
          last_offered_date: dateOnly, // ✅ útil para "otro día" / "más horarios"
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // ✅ Caso CLAVE: ya existe slot elegido (start/end), pero el usuario mandó nombre+email
  // (por ejemplo viene de confirm -> ask_all). No debemos pedir fecha/hora otra vez.
  if (hasChosenSlot && (name || email || phone) && !parsed?.startISO) {
    const missingName = !name;
    const missingEmail = !email;
    const missingPhone = isMeta && !phone;

    // Si aún falta algo, pide SOLO el faltante y TE QUEDAS EN ask_all
    if (missingName || missingEmail || missingPhone) {
      const want =
        missingName ? (effectiveLang === "en" ? "your full name" : "tu nombre completo")
        : missingEmail ? (effectiveLang === "en" ? "your email" : "tu email")
        : (effectiveLang === "en" ? "your phone number (with country code)" : "tu teléfono (con código de país)");

      const ex =
        missingName ? (effectiveLang === "en" ? "John Smith" : "Juan Pérez")
        : missingEmail ? "name@email.com"
        : "+13055551234";

      return {
        handled: true,
        reply: effectiveLang === "en"
          ? `I’m just missing ${want}. Example: ${ex}`
          : `Solo me falta ${want}. Ej: ${ex}`,
        ctxPatch: {
          booking: {
            ...hydratedBooking,
            step: "ask_all",
            lang: effectiveLang,
            timeZone: tz, 
            name,
            email,
            phone,
          },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    // ✅ Ya tengo todo lo necesario -> vuelve a confirm sin fricción
    const whenTxt = formatSlotHuman({ startISO: hydratedBooking.start_time, timeZone: tz, idioma: effectiveLang  });

    return {
      handled: true,
      reply:
        effectiveLang === "en"
          ? `Perfect — everything is ready. To finalize ${whenTxt}, reply YES or NO.`
          : `Perfecto — ya tengo todo listo. Para finalizar ${whenTxt}, responde SI o NO.`,
        ctxPatch: {
          booking: {
            ...hydratedBooking,
            step: "confirm",
            lang: effectiveLang,
            timeZone: tz,
            name,
            email,
            phone,
            start_time: hydratedBooking.start_time,
            end_time: hydratedBooking.end_time,
          },
          booking_last_touch_at: Date.now(),
        },
      };
    }

  // ✅ Si vino completo, vamos directo a confirm
  if (name && email && parsed?.startISO && parsed?.endISO && (!isMeta || phone)) {
    const whenTxt = formatSlotHuman({ startISO: parsed.startISO, timeZone: tz, idioma: effectiveLang  });
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
          lang: effectiveLang,
          timeZone: tz,
          name: parsed.name,
          email: parsed.email,
          phone,
          start_time: parsed.startISO,
          end_time: parsed.endISO,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // ✅ Fallbacks: pedir SOLO lo que falta (en orden)
  // ✅ Fallbacks: pedir SOLO lo que falta, pero SIEMPRE en ask_all
const missingName = !name;
const missingEmail = !email;
const missingPhone = isMeta && !phone;

if (missingName || missingEmail || missingPhone) {
  const want =
    missingName ? (effectiveLang === "en" ? "your full name" : "tu nombre completo")
    : missingEmail ? (effectiveLang === "en" ? "your email" : "tu email")
    : (effectiveLang === "en" ? "your phone number (with country code)" : "tu teléfono (con código de país)");

  const ex =
    missingName ? (effectiveLang === "en" ? "John Smith" : "Juan Pérez")
    : missingEmail ? "name@email.com"
    : "+13055551234";

  return {
    handled: true,
    reply: effectiveLang === "en"
      ? `I’m just missing ${want}. Example: ${ex}`
      : `Solo me falta ${want}. Ej: ${ex}`,
    ctxPatch: {
      booking: {
        ...hydratedBooking,
        step: "ask_all",
        lang: effectiveLang,
        timeZone: tz, 
        name,
        email,
        phone,
      },
      booking_last_touch_at: Date.now(),
    },
  };
}

  // Falta fecha/hora
  return {
    handled: true,
    reply:
      effectiveLang === "en"
        ? "I’m missing the date/time. Please use: YYYY-MM-DD HH:mm (example: 2026-01-21 14:00)."
        : "Me falta la fecha y hora. Usa: YYYY-MM-DD HH:mm (ej: 2026-01-21 14:00).",
    ctxPatch: {
      booking: {
        ...hydratedBooking,
        step: "ask_datetime",
        lang: effectiveLang,
        timeZone: tz,
        name,
        email,
        phone,
      },
      booking_last_touch_at: Date.now(),
    },
  };
}
