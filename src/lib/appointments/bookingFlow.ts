// src/lib/appointments/bookingFlow.ts
import { googleFreeBusy, googleCreateEvent } from "../../services/googleCalendar";
import { canUseChannel } from "../features";
import { DateTime } from "luxon";
import type { BookingCtx } from "./booking/types";
import {
  getAppointmentSettings,
  getBusinessHours,
  isGoogleConnected,
  loadBookingTerms,
  upsertClienteBookingData,
  markAppointmentConfirmed,
  markAppointmentFailed,
  createPendingAppointmentOrGetExisting,
} from "./booking/db";
import {
  EMAIL_REGEX,
  normalizeText,
  hasExplicitDateTime,
  hasAppointmentContext,
  isCapabilityQuestion,
  isDirectBookingRequest,
  detectDaypart,
  detectPurpose,
  wantsToCancel,
  wantsMoreSlots,
  wantsToChangeTopic,
  matchesBookingIntent,
  extractDateTimeToken,
  extractDateOnlyToken,
  parseEmail,
  parseFullName,
  parseAllInOne,
  parseNameEmailOnly,
  buildAskAllMessage,
} from "./booking/text";

import {
  MIN_LEAD_MINUTES,
  isPastSlot,
  parseDateTimeExplicit,
  isWithinBusinessHours,
  formatBizWindow,
  formatSlotHuman,
  renderSlotsMessage,
  parseSlotChoice,
  weekdayKey,
} from "./booking/time";
import { getNextSlotsByDaypart, getSlotsForDate } from "./booking/slots";
import { extractTimeOnlyToken } from "./booking/text";
import { filterSlotsNearTime } from "./booking/time";
import { extractBusyBlocks } from "./booking/freebusy";
import { extractTimeConstraint } from "./booking/text";
import { filterSlotsByConstraint } from "./booking/time";


async function bookInGoogle(opts: {
  tenantId: string;
  customer_name: string;
  customer_phone?: string | null;
  customer_email?: string | null;
  startISO: string;
  endISO: string;
  timeZone: string;
  bufferMin: number;
}) {
  const { tenantId, customer_name, startISO, endISO, timeZone, bufferMin } = opts;

  const start = DateTime.fromISO(startISO, { zone: timeZone });
  const end = DateTime.fromISO(endISO, { zone: timeZone });

  if (!start.isValid || !end.isValid) {
    return { ok: false as const, error: "INVALID_DATETIME" as const, busy: [] as any[] };
  }

  // ✅ BLOQUEO FINAL: NO permitir eventos en el pasado
  const now = DateTime.now().setZone(timeZone);
  if (start < now.plus({ minutes: MIN_LEAD_MINUTES })) {
    return { ok: false as const, error: "PAST_SLOT" as const, busy: [] as any[] };
  }

  // ✅ NUEVO: valida contra horario del negocio (si existe)
  try {
    const hours = await getBusinessHours(tenantId);
    if (hours) {
      const check = isWithinBusinessHours({
        hours,
        startISO,
        endISO,
        timeZone,
      });
      if (!check.ok) {
        return { ok: false as const, error: "OUTSIDE_BUSINESS_HOURS" as const, busy: [] as any[] };
      }
    }
  } catch {}

  const timeMin = start.minus({ minutes: bufferMin }).toISO();
  const timeMax = end.plus({ minutes: bufferMin }).toISO();

  if (!timeMin || !timeMax) {
    return { ok: false as const, error: "INVALID_DATETIME" as const, busy: [] as any[] };
  }

  // ✅ aquí ya son string seguros
  const fb = await googleFreeBusy({
    tenantId,
    timeMin,
    timeMax,
    calendarId: "primary",
  });

  const busy = extractBusyBlocks(fb);
  console.log("📅 [BOOKING] freebusy", {
    tenantId,
    timeMin,
    timeMax,
    busyCount: busy.length,
  });

  if (busy.length > 0) {
    return { ok: false as const, error: "SLOT_BUSY" as const, busy };
  }

    const phone = (opts.customer_phone || "").trim();
    const email = (opts.customer_email || "").trim();

    const descriptionLines = [
        "Agendado por Aamy",
        `Cliente: ${customer_name}`,
        phone ? `Teléfono: ${phone}` : null,
        email ? `Email: ${email}` : null,
    ].filter(Boolean);

    const event = await googleCreateEvent({
        tenantId,
        calendarId: "primary",
        summary: `Reserva: ${customer_name}`,
        description: descriptionLines.join("\n"),
        startISO,
        endISO,
        timeZone,
    });

  return {
    ok: true as const,
    event_id: event?.id || null,
    htmlLink: event?.htmlLink || null,
  };
}

export async function bookingFlowMvp(opts: {
  tenantId: string;
  canal: string; // "whatsapp"
  contacto: string;
  idioma: "es" | "en";
  userText: string;
  ctx: any; // convoCtx (object)
  bookingLink?: string | null; // ✅ viene del prompt
  messageId?: string | null; // ✅ NUEVO
}): Promise<{
  handled: boolean;
  reply?: string;
  ctxPatch?: any;
}> {
  const { tenantId, canal, contacto, idioma, userText } = opts;

  const messageId = opts.messageId ? String(opts.messageId) : null;

  const ctx = (opts.ctx && typeof opts.ctx === "object") ? (opts.ctx as BookingCtx) : {};
  const booking = ctx.booking || { step: "idle" as const };

  // ✅ carga settings del tenant (MVP)
  const apptSettings = await getAppointmentSettings(tenantId);

  if (apptSettings.enabled === false) {
    const quickWants =
      booking.step !== "idle" ||
      hasExplicitDateTime(userText) ||
      hasAppointmentContext(userText);

    if (quickWants) {
      return {
      handled: true,
      reply: idioma === "en"
        ? "Scheduling is unavailable right now."
        : "El agendamiento no está disponible en este momento.",
      ctxPatch: { booking: { step: "idle" } },
      };
    }

    return { handled: false };
  }

  // ✅ timezone real del negocio (prioridad: ctx > settings > fallback)
  const timeZone = booking.timeZone || apptSettings.timezone || "America/New_York";

  // ✅ valores MVP
  const durationMin = apptSettings.default_duration_min ?? 30;
  const bufferMin = apptSettings.buffer_min ?? 10;

  const hours = await getBusinessHours(tenantId);

  // ✅ POST-BOOKING GUARD (SAFE):
  // NO usar last_appointment_id como gatillo global.
  // Solo responde con link si el booking se completó RECIENTEMENTE.
  const t0 = String(userText || "").trim().toLowerCase();
  const isYesNo = /^(si|sí|yes|y|no|n)$/i.test(t0);

  if (booking.step === "idle" && isYesNo) {
    const lastDoneAt =
      (opts.ctx && typeof opts.ctx === "object") ? (opts.ctx as any)?.booking_last_done_at : null;

    const lastMs = typeof lastDoneAt === "number" ? lastDoneAt : null;

    // ventana corta: 5 minutos
    const withinWindow =
      lastMs && Number.isFinite(lastMs)
        ? ((Date.now() - lastMs) >= 0 && (Date.now() - lastMs) < 5 * 60 * 1000)
        : false;

    if (withinWindow) {
      const lastLink =
        (opts.ctx && typeof opts.ctx === "object") ? (opts.ctx as any)?.booking_last_event_link : null;

      const link = typeof lastLink === "string" ? lastLink.trim() : "";

      // si no hay link, no interceptes (deja que el SM responda)
      if (!link) return { handled: false };

      return {
        handled: true,
        reply: idioma === "en"
          ? `Already booked. ${link}`.trim()
          : `Ya quedó agendado. ${link}`.trim(),
        ctxPatch: {
          booking: { step: "idle" },
          // ✅ opcional: limpia ids viejos para que nunca se usen como gatillo
          last_appointment_id: null,
        },
      };
    }
  }

  const terms = await loadBookingTerms(tenantId);
  const rawWants = matchesBookingIntent(userText, terms);

  const capability = isCapabilityQuestion(userText);
  const directReq = isDirectBookingRequest(userText);

  const wantsBooking =
    hasExplicitDateTime(userText) ||
    directReq ||
    (rawWants && !capability) ||
    (hasAppointmentContext(userText) && !capability);

  if (booking.step === "idle" && capability && hasAppointmentContext(userText) && !hasExplicitDateTime(userText) && !directReq) {
    return {
      handled: true,
      reply: idioma === "en"
  ? "Yes — Aamy can schedule your business appointments using Google Calendar. Would you like to schedule a call with our team to learn more? Reply: 'I want to schedule'."
  : "Sí — Aamy puede agendar las citas de tu negocio usando Google Calendar. ¿Te gustaría programar una llamada con nuestro equipo para saber más? Escribe: 'Quiero agendar'.",
      ctxPatch: { booking: { step: "idle" } },
    };
  }

  const gate = await canUseChannel(tenantId, "google_calendar");
  const bookingEnabled = !!gate.settings_enabled;
  console.log("📅 [BOOKING] gate:", { settings_enabled: gate.settings_enabled, plan_enabled: gate.plan_enabled, enabled: gate.enabled });

  const googleConnected = await isGoogleConnected(tenantId);

  const bookingLink = opts.bookingLink ? String(opts.bookingLink).trim() : null;

  // 1) Si el tenant apagó agendamiento: bloquea todo
  if (!bookingEnabled) {
    if (wantsBooking || booking.step !== "idle") {
      return {
        handled: true,
        reply: idioma === "en"
            ? "Scheduling is unavailable right now."
            : "El agendamiento no está disponible en este momento.",
        ctxPatch: { booking: { step: "idle" } },
      };
    }
    return { handled: false };
  }

// 2) Si hay link, responde con el link (y NO uses Google)
if (wantsBooking && bookingLink) {
  return {
    handled: true,
    reply: idioma === "en"
      ? `You can book here: ${bookingLink}`
      : `Puedes agendar aquí: ${bookingLink}`,
    ctxPatch: { booking: { step: "idle" } },
  };
}

// 3) Si NO hay link y Google NO está conectado: no inicies flujo
if (wantsBooking && !bookingLink && !googleConnected) {
  return {
    handled: true,
    reply: idioma === "en"
      ? "Scheduling is unavailable right now."
      : "El agendamiento no está disponible en este momento.",
    ctxPatch: { booking: { step: "idle" } },
  };
}

// 1) Arranque: detecta intención y pide fecha/hora
if (booking.step === "idle") {
  if (!wantsBooking) return { handled: false };

  const purpose = detectPurpose(userText);

  // ✅ solo si NO detecta propósito -> pregunta
  if (!purpose) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "Sure! What would you like to schedule — an appointment, a consultation, or a call?"
        : "¡Claro! ¿Qué te gustaría agendar? Una cita, una consulta o una llamada.",
      ctxPatch: { booking: { step: "ask_purpose", timeZone } },
    };
  }

  // ✅ ya hay propósito -> primero pregunta mañana o tarde
  return {
    handled: true,
    reply: idioma === "en"
      ? "Sure, I can help you schedule it. Does morning or afternoon work better for you?"
      : "Claro, puedo ayudarte a agendar. ¿Te funciona más en la mañana o en la tarde?",
    ctxPatch: { booking: { step: "ask_daypart", timeZone, purpose } },
  };
}

if (booking.step === "ask_purpose") {
  if (wantsToChangeTopic(userText)) {
    return { handled: false, ctxPatch: { booking: { step: "idle" } } };
  }

  const purpose = detectPurpose(userText);

  if (!purpose) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "Got it. Is it an appointment, class, consultation, or a call?"
        : "Entiendo. ¿Es una cita, clase, consulta o llamada?",
      ctxPatch: { booking: { ...booking, step: "ask_purpose", timeZone } },
    };
  }

  // ✅ AQUI: primero daypart
  return {
    handled: true,
    reply: idioma === "en"
      ? "Sure, I can help you schedule it. Does morning or afternoon work better for you?"
      : "Claro, puedo ayudarte a agendar. ¿Te funciona más en la mañana o en la tarde?",
    ctxPatch: { booking: { step: "ask_daypart", timeZone, purpose } },
  };
}

if (booking.step === "ask_daypart") {
  if (wantsToChangeTopic(userText)) {
    return { handled: false, ctxPatch: { booking: { step: "idle" } } };
  }

  if (wantsToCancel(userText)) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "No worries, whenever you’re ready to schedule, I’ll be here to help."
        : "No hay problema, cuando necesites agendar estaré aquí para ayudarte.",
      ctxPatch: { booking: { step: "idle" } },
    };
  }

  const dp = detectDaypart(userText);
  if (!dp) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "Please reply: morning or afternoon."
        : "Respóndeme: mañana o tarde.",
      ctxPatch: { booking: { ...booking, step: "ask_daypart", timeZone } },
    };
  }

  // Si no hay horario configurado
  if (!hours) {
    return {
        handled: true,
        reply: buildAskAllMessage(idioma, booking.purpose || null),
        ctxPatch: {
        booking: {
            ...booking,
            step: "ask_all",
            timeZone,
            daypart: dp,
        },
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
        purpose: booking.purpose || null,
        daypart: dp,
        slots,
        date_only: null,
        last_offered_date: dateOnlyFromFirst, // ✅ NUEVO
      },
    },
  };
}

if (booking.step === "ask_all") {
  if (wantsToChangeTopic(userText)) {
    return { handled: false, ctxPatch: { booking: { step: "idle" } } };
  }

  if (wantsToCancel(userText)) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "Of course, no problem. I’ll stop the process for now. Whenever you’re ready, just tell me."
        : "Claro, no hay problema. Detengo todo por ahora. Cuando estés listo, solo avísame.",
      ctxPatch: { booking: { step: "idle", start_time: null, end_time: null, timeZone, name: null, email: null, purpose: null, date_only: null } },
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
        reply: idioma === "en"
          ? "That date/time is in the past. Please send a future date and time (YYYY-MM-DD HH:mm)."
          : "Esa fecha/hora ya pasó. Envíame una fecha y hora futura (YYYY-MM-DD HH:mm).",
        ctxPatch: {
          booking: {
            step: "ask_datetime",
            timeZone,
            name: parsed.name || (booking as any)?.name || null,
            email: parsed.email || (booking as any)?.email || null,
            date_only: null,
          },
        },
      };
    }
  }

  const dateOnly = extractDateOnlyToken(userText);
  if (dateOnly && parsed.name && parsed.email && !parsed.startISO) {
    // bloquea fecha pasada (lo dejas igual que ya lo tienes)
    const dateOnlyDt = DateTime.fromFormat(dateOnly, "yyyy-MM-dd", { zone: timeZone });
    const todayStart = DateTime.now().setZone(timeZone).startOf("day");
    if (dateOnlyDt.isValid && dateOnlyDt < todayStart) {
      return {
        handled: true,
        reply: idioma === "en"
            ? "That date is in the past. Please send a future date (YYYY-MM-DD)."
            : "Esa fecha ya pasó. Envíame una fecha futura (YYYY-MM-DD).",
        ctxPatch: {
            booking: { step: "ask_datetime", timeZone, name: parsed.name, email: parsed.email, date_only: null, slots: [] },
        },
      };
    }

    if (!hours) {
      return {
        handled: true,
        reply: idioma === "en"
          ? `Got it — what time works for you on ${dateOnly}? Reply with HH:mm (example: 14:00).`
          : `Perfecto — ¿a qué hora te gustaría el ${dateOnly}? Respóndeme con HH:mm (ej: 14:00).`,
        ctxPatch: {
          booking: {
            step: "ask_datetime",
            timeZone,
            name: parsed.name,
            email: parsed.email,
            date_only: dateOnly, // ✅ CLAVE: guarda la fecha para que acepte "HH:mm"
            slots: [],
          },
        },
      };
    }

    // ✅ NUEVO: generar slots para ese día
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
          purpose: booking.purpose || null,
          date_only: dateOnly,
          slots,
        },
      },
    };
  }

  // Si vino completo, vamos directo a confirm
  if (parsed.name && parsed.email && parsed.startISO && parsed.endISO) {
    const whenTxt = formatSlotHuman({ startISO: parsed.startISO, timeZone, idioma });
    return {
      handled: true,
      reply: idioma === "en"
        ? `To confirm booking for ${whenTxt}? Reply YES to confirm or NO to cancel.`
        : `Para confirmar: ${whenTxt}. Responde SI para confirmar o NO para cancelar.`,
      ctxPatch: {
        booking: {
          step: "confirm",
          timeZone,
          name: parsed.name,
          email: parsed.email,       // ✅ obligatorio
          start_time: parsed.startISO,
          end_time: parsed.endISO,
        },
      },
    };
  }

  // Si falta algo, hacemos fallback pidiendo SOLO lo faltante (en orden)
  if (!parsed.name) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "I’m missing your first and last name (example: John Smith)."
        : "Me falta tu nombre y apellido (ej: Juan Pérez).",
      ctxPatch: {
        booking: {
          step: "ask_name",
          timeZone,
          email: parsed.email || (booking as any)?.email || null,
        },
      },
    };
  }

  if (!parsed.email) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "I’m missing your email (example: name@email.com)."
        : "Me falta tu email (ej: nombre@email.com).",
      ctxPatch: {
        booking: {
          step: "ask_email",
          timeZone,
          name: parsed.name || (booking as any)?.name || null,
        },
      },
    };
  }

  // Falta fecha/hora
  return {
    handled: true,
    reply: idioma === "en"
      ? "I’m missing the date/time. Please use: YYYY-MM-DD HH:mm (example: 2026-01-21 14:00)."
      : "Me falta la fecha y hora. Usa: YYYY-MM-DD HH:mm (ej: 2026-01-21 14:00).",
    ctxPatch: {
      booking: {
        step: "ask_datetime",
        timeZone,
        name: parsed.name || (booking as any)?.name || null,
        email: parsed.email || (booking as any)?.email || null, // ✅ si ya lo tenía
      },
    },
  };
}

// 1.1) Esperando nombre y apellido
if (booking.step === "ask_name") {
  // Escape si cambió de tema -> salimos del flow
  if (wantsToChangeTopic(userText)) {
    return {
      handled: false,
      ctxPatch: { booking: { step: "idle" } },
    };
  }

  if (wantsToCancel(userText)) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "Of course, no problem. I’ll stop the process for now. Whenever you’re ready, just tell me."
        : "Claro, no hay problema. Detengo todo por ahora. Cuando estés listo, solo avísame.",
      ctxPatch: { booking: { step: "idle" } },
    };
  }

  const name = parseFullName(userText);
  if (!name) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "Please send your first and last name (example: John Smith)."
        : "Envíame tu nombre y apellido (ej: Juan Pérez).",
      ctxPatch: { booking: { ...booking, step: "ask_name", timeZone } },
    };
  }

  await upsertClienteBookingData({
    tenantId,
    canal,
    contacto,
    nombre: name,
  });

  return {
    handled: true,
    reply: idioma === "en"
      ? "Thanks. Now send your email."
      : "Gracias. Ahora envíame tu email.",
    ctxPatch: {
      booking: {
        step: "ask_email",
        timeZone,
        name,
      },
    },
  };
}

// 1.2) Esperando email (OBLIGATORIO)
if (booking.step === "ask_email") {
  // Escape si cambió de tema -> salimos del flow
  if (wantsToChangeTopic(userText)) {
    return {
      handled: false,
      ctxPatch: { booking: { step: "idle" } },
    };
  }

  if (wantsToCancel(userText)) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "Of course, no problem. I’ll stop the process for now. Whenever you’re ready, just tell me."
        : "Claro, no hay problema. Detengo todo por ahora. Cuando estés listo, solo avísame.",
      ctxPatch: { booking: { step: "idle" } },
    };
  }

  const email = parseEmail(userText);
  if (!email) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "Please send a valid email (example: name@email.com)."
        : "Envíame un email válido (ej: nombre@email.com).",
      ctxPatch: { booking: { ...booking, step: "ask_email", timeZone } },
    };
  }

  await upsertClienteBookingData({
    tenantId,
    canal,
    contacto,
    nombre: (booking as any)?.name || null,
    email,
  });

  return {
    handled: true,
    reply: idioma === "en"
      ? "Great. Now send the date and time in this format: YYYY-MM-DD HH:mm (example: 2026-01-17 15:00)."
      : "Perfecto. Ahora envíame la fecha y hora en este formato: YYYY-MM-DD HH:mm (ej: 2026-01-17 15:00).",
    ctxPatch: {
      booking: {
        step: "ask_datetime",
        timeZone,
        name: (booking as any)?.name, // preserva lo capturado
        email,
      },
    },
  };
}

if (booking.step === "offer_slots") {
  const t = normalizeText(userText);
  const slots = Array.isArray((booking as any)?.slots) ? (booking as any).slots : [];

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
            slots: [],
          },
        },
      };
    }

    // ✅ NUEVO: pide más opciones aunque no escriba "horario"
    if (wantsMoreSlots(userText)) {
    const lastStartISO = slots.length ? slots[slots.length - 1].startISO : null;

    if (!hours) {
        return {
        handled: true,
        reply: idioma === "en"
            ? "Please send a date and time (YYYY-MM-DD HH:mm)."
            : "Por favor envíame fecha y hora (YYYY-MM-DD HH:mm).",
        ctxPatch: { booking: { ...booking, step: "ask_datetime", date_only: null, slots: [] } },
        };
    }

    const dp = (booking as any)?.daypart as ("morning" | "afternoon" | null) || null;

    let newSlots: Array<{ startISO: string; endISO: string }> = [];

    if (dp) {
    newSlots = await getNextSlotsByDaypart({
        tenantId,
        timeZone,
        durationMin,
        bufferMin,
        hours,
        daypart: dp,
        daysAhead: 14,
        afterISO: lastStartISO,
    });
    } else {
    // 1) intenta morning
    newSlots = await getNextSlotsByDaypart({
        tenantId,
        timeZone,
        durationMin,
        bufferMin,
        hours,
        daypart: "morning",
        daysAhead: 14,
        afterISO: lastStartISO,
    });

    // 2) si no hay, intenta afternoon
    if (!newSlots.length) {
        newSlots = await getNextSlotsByDaypart({
        tenantId,
        timeZone,
        durationMin,
        bufferMin,
        hours,
        daypart: "afternoon",
        daysAhead: 14,
        afterISO: lastStartISO,
        });
      }
    }

    if (!newSlots.length) {
        return {
        handled: true,
        reply: idioma === "en"
            ? "I couldn’t find more available times. Please tell me another date (YYYY-MM-DD)."
            : "No encontré más horarios disponibles. Envíame otra fecha (YYYY-MM-DD).",
        ctxPatch: { booking: { ...booking, step: "ask_datetime", date_only: null, slots: [] } },
        };
    }

    return {
      handled: true,
      reply: renderSlotsMessage({ idioma, timeZone: booking.timeZone || timeZone, slots: newSlots }),
      ctxPatch: {
        booking: {
          ...booking,
          step: "offer_slots",
          timeZone: booking.timeZone || timeZone,
          slots: newSlots,
          date_only: null,
        },
      },
    };
  }

    // Si pregunta por horarios estando en offer_slots, simplemente re-muestra opciones
    if (/\b(horario|horarios|hours|available)\b/i.test(t)) {

    return {
        handled: true,
        reply: renderSlotsMessage({ idioma, timeZone: booking.timeZone || timeZone, slots }),
        ctxPatch: { booking },
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
      ctxPatch: { booking: { step: "idle" } },
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
            last_offered_date: (booking as any)?.last_offered_date || null,
          },
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
              date_only: ctxDate, // ✅ así luego acepta "HH:mm"
            },
          },
        };
      }
    }
  }

  // ✅ NUEVO: interpretar frases vagas ("después de las 4", "lo más temprano", "tipo 5 y algo", "cuando puedas por la tarde")
  const constraint = extractTimeConstraint(userText);

  if (constraint) {
    const filtered = filterSlotsByConstraint({
      slots,
      timeZone: booking.timeZone || timeZone,
      constraint,
      max: 5,
    });

    // Si no filtró nada (raro), vuelve a mostrar los slots actuales
    const useSlots = filtered.length ? filtered : slots;

    return {
      handled: true,
      reply: renderSlotsMessage({ idioma, timeZone: booking.timeZone || timeZone, slots: useSlots }),
      ctxPatch: {
        booking: {
          ...booking,
          step: "offer_slots",
          timeZone: booking.timeZone || timeZone,
          slots: useSlots,
        },
      },
    };
  }

  const choice = parseSlotChoice(userText, slots.length);

  if (!choice) {
    return {
      handled: true,
      reply: idioma === "en"
        ? `Please, Reply with a number (1-${slots.length}) or ask for another time (example: "5pm").`
        : `Por favor Responde con un número (1-${slots.length}) o dime una hora (ej: "5pm" o "17:00").`,
      ctxPatch: { booking },
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
    },
  };
}

if (booking.step === "ask_contact") {
  if (wantsToChangeTopic(userText)) {
    return { handled: false, ctxPatch: { booking: { step: "idle" } } };
  }

  if (wantsToCancel(userText)) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "No worries, whenever you’re ready to schedule, I’ll be here to help."
        : "No hay problema, cuando necesites agendar estaré aquí para ayudarte.",
      ctxPatch: { booking: { step: "idle" } },
    };
  }

  const { name, email } = parseNameEmailOnly(userText);

  if (!name) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "I’m missing your first and last name (example: John Smith)."
        : "Me falta tu nombre y apellido (ej: Juan Pérez).",
      ctxPatch: { booking: { ...booking, step: "ask_contact" } },
    };
  }

  if (!email || !parseEmail(email)) {
    return {
      handled: true,
      reply: idioma === "en"
        ? "I’m missing a valid email (example: name@email.com)."
        : "Me falta un email válido (ej: nombre@email.com).",
      ctxPatch: { booking: { ...booking, step: "ask_contact" } },
    };
  }

  const startISO = (booking as any)?.picked_start || null;
  const endISO = (booking as any)?.picked_end || null;

  if (!startISO || !endISO) {
    return { handled: false, ctxPatch: { booking: { step: "idle" } } };
  }

  await upsertClienteBookingData({ tenantId, canal, contacto, nombre: name, email });

  const whenTxt = formatSlotHuman({ startISO, timeZone, idioma });

  return {
    handled: true,
    reply: idioma === "en"
      ? `To confirm booking for ${whenTxt}? Reply YES to confirm or NO to cancel.`
      : `Para confirmar: ${whenTxt}. Responde SI para confirmar o NO para cancelar.`,
    ctxPatch: {
      booking: {
        step: "confirm",
        timeZone,
        name,
        email,
        start_time: startISO,
        end_time: endISO,
        picked_start: null,
        picked_end: null,
      },
    },
  };
}

  // 2) Esperando fecha/hora
  if (booking.step === "ask_datetime") {
    // ✅ ESCAPE: si el usuario cambió de tema, salimos del flow
    if (wantsToChangeTopic(userText)) {
        return {
        handled: false,                 // deja que el SM/LLM responda
        ctxPatch: { booking: { step: "idle" } }, // resetea el wizard
        };
    }

    if (wantsToCancel(userText)) {
      return {
        handled: true,
        reply: idioma === "en"
          ? "Of course, no problem. I’ll stop the process for now. Whenever you’re ready, just tell me."
          : "Claro, no hay problema. Detengo todo por ahora. Cuando estés listo, solo avísame.",
        ctxPatch: { booking: { step: "idle" } },
      };
    }

    const parsed: any = parseDateTimeExplicit(userText, timeZone, durationMin);

    const b: any = booking;
    const hhmmOnly = String(userText || "").trim().match(/^(\d{1,2}:\d{2})$/);
    const flex = extractTimeOnlyToken(userText); // ✅ nuevo: acepta 5pm, a las 5, etc.

    const dateCtx = b?.date_only || b?.last_offered_date || null;

    if (dateCtx && (hhmmOnly || flex)) {
    const hhmmVal = hhmmOnly ? hhmmOnly[1].padStart(5, "0") : (flex as string);
    const parsed2: any = parseDateTimeExplicit(`${dateCtx} ${hhmmVal}`, timeZone, durationMin);

    if (!parsed2) {
      return {
        handled: true,
        reply: idioma === "en"
            ? `I couldn’t read that time. Please use HH:mm (example: 14:00).`
            : `No pude leer esa hora. Usa HH:mm (ej: 14:00).`,
        ctxPatch: { booking: { ...booking, step: "ask_datetime", timeZone } },
      };
    }

    if (parsed2?.error === "PAST_SLOT") {
      return {
        handled: true,
        reply: idioma === "en"
            ? "That time is in the past. Please send a future time."
            : "Esa hora ya pasó. Envíame una hora futura.",
        ctxPatch: { booking: { ...booking, step: "ask_datetime", timeZone } },
      };
    }

    const whenTxt = formatSlotHuman({ startISO: parsed2.startISO!, timeZone, idioma });

    return {
      handled: true,
      reply: idioma === "en"
        ? `To confirm booking for ${whenTxt}? Reply YES to confirm or NO to cancel.`
        : `Para confirmar: ${whenTxt}. Responde SI para confirmar o NO para cancelar.`,
      ctxPatch: {
        booking: {
          ...booking,
          step: "confirm",
          start_time: parsed2.startISO,
          end_time: parsed2.endISO,
          timeZone,
          date_only: null,
        },
      },
    };
  }

    if (!parsed) {
      return {
        handled: true,
        reply: idioma === "en"
          ? "I couldn’t read that. Please use: YYYY-MM-DD HH:mm (example: 2026-01-17 15:00)."
          : "No pude leer esa fecha/hora. Usa: YYYY-MM-DD HH:mm (ej: 2026-01-17 15:00).",
        ctxPatch: { booking: { ...booking, step: "ask_datetime", timeZone } },
      };
    }

    // ✅ BLOQUEO: fecha/hora en el pasado
    if (parsed?.error === "PAST_SLOT") {
      return {
        handled: true,
        reply: idioma === "en"
          ? "That date/time is in the past. Please send a future date and time (YYYY-MM-DD HH:mm)."
          : "Esa fecha/hora ya pasó. Envíame una fecha y hora futura (YYYY-MM-DD HH:mm).",
        ctxPatch: { booking: { ...booking, step: "ask_datetime", timeZone } },
      };
    }

    // ✅ NUEVO: valida contra horario del negocio
    if (hours && parsed?.startISO && parsed?.endISO) {
      const check = isWithinBusinessHours({
        hours,
        startISO: parsed.startISO,
        endISO: parsed.endISO,
        timeZone,
    });

      if (!check.ok) {
        if (check.reason === "closed") {
          return {
            handled: true,
            reply: idioma === "en"
            ? "We’re closed that day. Please choose another date."
            : "Ese día estamos cerrados. Envíame otra fecha.",
            ctxPatch: { booking: { ...booking, step: "ask_datetime", timeZone } },
          };
        }

        if (check.reason === "outside" && (check as any).bizStart && (check as any).bizEnd) {
          const windowTxt = formatBizWindow(idioma, (check as any).bizStart, (check as any).bizEnd);
          return {
            handled: true,
            reply: idioma === "en"
              ? `That time is outside business hours (${windowTxt}). Please send a time within that range.`
              : `Esa hora está fuera del horario (${windowTxt}). Envíame una hora dentro de ese rango.`,
            ctxPatch: { booking: { ...booking, step: "ask_datetime", timeZone } },
          };
        }
      }
    }

    const whenTxt = formatSlotHuman({ startISO: parsed.startISO!, timeZone, idioma });
    return {
      handled: true,
      reply: idioma === "en"
        ? `To confirm booking for ${whenTxt}? Reply YES to confirm or NO to cancel.`
        : `Para confirmar: ${whenTxt}. Responde SI para confirmar o NO para cancelar.`,
      ctxPatch: {
          booking: {
            ...booking,            // ✅ preserva name/email
            step: "confirm",
            start_time: parsed.startISO,
            end_time: parsed.endISO,
            timeZone,
          },
      },
    };
  }

  // 3) Confirmación SI/NO
  if (booking.step === "confirm") {
    const t = String(userText || "").trim().toLowerCase();
    const yes = /^(si|sí|yes|y)$/i.test(t);
    const no = /^(no|n)$/i.test(t);

    if (!booking.email) {
      return {
        handled: true,
        reply: idioma === "en"
          ? "Before confirming, please send your email (example: name@email.com)."
          : "Antes de confirmar, envíame tu email (ej: nombre@email.com).",
        ctxPatch: { booking: { ...booking, step: "ask_email", timeZone: booking.timeZone || timeZone } },
      };
    }

    if (!yes && !no) {
      return {
        handled: true,
        reply: idioma === "en"
          ? "Please reply YES to confirm or NO to cancel."
          : "Responde SI para confirmar o NO para cancelar.",
        ctxPatch: { booking },
      };
    }

    if (no) {
      return {
        handled: true,
        reply: idioma === "en"
          ? "No problem. Send me another date and time (YYYY-MM-DD HH:mm)."
          : "Perfecto. Envíame otra fecha y hora (YYYY-MM-DD HH:mm).",
        ctxPatch: {
          booking: {
            ...booking, // ✅ preserva name/email/purpose/lo que exista
            step: "ask_datetime", // 🔑 OBLIGATORIO
            timeZone: booking.timeZone || timeZone,

            // preservamos datos válidos
            name: booking.name || null,
            email: booking.email || null,
            purpose: booking.purpose || null,

            // limpiamos COMPLETAMENTE el slot anterior
            start_time: null,
            end_time: null,
            date_only: null,
          },
        },
      };
    }

    if (wantsToCancel(userText)) {
      return {
        handled: true,
        reply: idioma === "en"
          ? "Of course, no problem. I’ll stop the process for now. Whenever you’re ready, just tell me."
          : "Claro, no hay problema. Detengo todo por ahora. Cuando estés listo, solo avísame.",
        ctxPatch: { booking: { step: "idle" } },
      };
    }

    // YES -> agenda en Google + guarda en DB
    const customer_name = booking.name || "Cliente";
    const customer_email = booking.email; // ya no debería ser null

    if (!booking.start_time || !booking.end_time) {
      return {
        handled: true,
        reply: idioma === "en"
          ? "Send me the date and time (YYYY-MM-DD HH:mm)."
          : "Envíame la fecha y hora (YYYY-MM-DD HH:mm).",
        ctxPatch: { booking: { ...booking, step: "ask_datetime" } },
      };
    }

    const startISO = booking.start_time!;
    const endISO = booking.end_time!;

    // ✅ DEDUPE REAL: crea/obtén un appointment PENDING con UNIQUE en DB
    const pending = await createPendingAppointmentOrGetExisting({
    tenantId,
    channel: canal,
    customer_name,
    customer_phone: contacto,
    customer_email: booking.email,
    start_time: startISO,
    end_time: endISO,
    });

    if (!pending) {
      return {
        handled: true,
        reply: idioma === "en"
          ? "Something went wrong creating your booking. Please try again."
          : "Ocurrió un problema creando la reserva. Por favor intenta de nuevo.",
        ctxPatch: { booking: { step: "ask_datetime", timeZone } },
      };
    }

    // Si ya estaba confirmado, responde idempotente con el link
    if (pending.status === "confirmed" && pending.google_event_link) {
      return {
        handled: true,
        reply: idioma === "en"
        ? `Already booked. ${pending.google_event_link}`.trim()
        : `Ya quedó agendado. ${pending.google_event_link}`.trim(),
        ctxPatch: { booking: { step: "idle" } },
      };
    }

    if (!googleConnected) {
      return {
        handled: true,
        reply: idioma === "en"
        ? "Scheduling isn’t available for this business right now."
        : "El agendamiento no está disponible en este momento para este negocio.",
        ctxPatch: { booking: { step: "idle" } },
      };
    }

    const g = await bookInGoogle({
      tenantId,
      customer_name,
      customer_phone: contacto,      // ✅ WhatsApp/Messenger sender id / phone
      customer_email: booking.email, // ✅ el email que capturaste
      startISO,
      endISO,
      timeZone,
      bufferMin,
    });

    if (!g.ok) {
      await markAppointmentFailed({
        apptId: pending.id,
        error_reason: String((g as any)?.error || "GOOGLE_ERROR"),
      });

      if ((g as any)?.error === "SLOT_BUSY") {
        // intentar proponer alternativas del MISMO día (si tenemos fecha)
        const day = DateTime.fromISO(startISO, { zone: timeZone });
        const dateISO = day.isValid ? day.toFormat("yyyy-MM-dd") : null;

        if (dateISO) {
          const slots = await getSlotsForDate({
            tenantId,
            timeZone,
            dateISO,
            durationMin,
            bufferMin,
            hours,
          });

          if (slots.length) {
            return {
              handled: true,
              reply: renderSlotsMessage({ idioma, timeZone, slots }),
              ctxPatch: {
                booking: {
                  ...booking,
                  step: "offer_slots",
                  timeZone,
                  slots,
                },
              },
            };
          }
        }
      }

      if ((g as any)?.error === "PAST_SLOT") {
        return {
          handled: true,
          reply: idioma === "en"
            ? "That date/time is in the past. Please send a future date and time (YYYY-MM-DD HH:mm)."
            : "Esa fecha/hora ya pasó. Envíame una fecha y hora futura (YYYY-MM-DD HH:mm).",
          ctxPatch: { booking: { step: "ask_datetime", timeZone } },
        };
      }

      if ((g as any)?.error === "OUTSIDE_BUSINESS_HOURS") {
        return {
          handled: true,
          reply: idioma === "en"
            ? "That time is outside business hours. Please choose a different time."
            : "Ese horario está fuera del horario de atención. Elige otro horario.",
          ctxPatch: { booking: { step: "ask_datetime", timeZone } },
        };
      }

      return {
        handled: true,
        reply: idioma === "en"
          ? "That time doesn’t seem to be available. Could you send me another date and time? (YYYY-MM-DD HH:mm)"
          : "Ese horario ya no está disponible. ¿Me compartes otra fecha y hora? (YYYY-MM-DD HH:mm)",
        ctxPatch: { booking: { step: "ask_datetime", timeZone } },
      };
    }

    await markAppointmentConfirmed({
      apptId: pending.id,
      google_event_id: g.event_id,
      google_event_link: g.htmlLink,
    });

    const apptId = pending.id;

    return {
      handled: true,
      reply: idioma === "en"
        ? `You're all set — your appointment is confirmed. ${g.htmlLink || ""}`.trim()
        : `Perfecto, tu cita quedó confirmada. ${g.htmlLink || ""}`.trim(),
      ctxPatch: {
        booking: { step: "idle" },
        last_appointment_id: apptId,
        booking_completed: true,
        booking_completed_at: new Date().toISOString(),
        booking_last_done_at: Date.now(),
        booking_last_event_link: g.htmlLink || null,
      },
    };
  }

  return { handled: false };
}
