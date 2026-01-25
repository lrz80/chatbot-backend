// src/lib/appointments/booking/handlers/confirm.ts
import { DateTime } from "luxon";
import { wantsToCancel } from "../text";
import { renderSlotsMessage } from "../time";
import { getSlotsForDate } from "../slots";

type ConfirmDeps = {
  tenantId: string;
  canal: string;
  contacto: string;
  idioma: "es" | "en";
  userText: string;

  booking: any; // BookingCtx.booking
  timeZone: string;

  durationMin: number;
  bufferMin: number;
  hours: any | null;

  googleConnected: boolean;

  // DB + side-effects (se inyectan)
  createPendingAppointmentOrGetExisting: (args: {
    tenantId: string;
    channel: string;
    customer_name: string;
    customer_phone?: string;
    customer_email?: string;
    start_time: string;
    end_time: string;
  }) => Promise<any | null>;

  markAppointmentFailed: (args: { apptId: string; error_reason: string }) => Promise<void>;
  markAppointmentConfirmed: (args: {
    apptId: string;
    google_event_id: string | null;
    google_event_link: string | null;
  }) => Promise<void>;

  bookInGoogle: (args: {
    tenantId: string;
    customer_name: string;
    customer_phone?: string | null;
    customer_email?: string | null;
    startISO: string;
    endISO: string;
    timeZone: string;
    bufferMin: number;
  }) => Promise<{ ok: boolean; event_id?: string | null; htmlLink?: string | null; error?: string; busy?: any[] }>;
};

export async function handleConfirm(deps: ConfirmDeps): Promise<{
  handled: boolean;
  reply?: string;
  ctxPatch?: any;
}> {
  const {
    tenantId,
    canal,
    contacto,
    idioma,
    userText,
    booking,
    timeZone,
    durationMin,
    bufferMin,
    hours,
    googleConnected,
    createPendingAppointmentOrGetExisting,
    markAppointmentFailed,
    markAppointmentConfirmed,
    bookInGoogle,
  } = deps;

  const t = String(userText || "").trim().toLowerCase();
  const yes = /^(si|sí|yes|y)$/i.test(t);
  const no = /^(no|n)$/i.test(t);

  // ✅ Hydrate start/end desde picked_* por seguridad
  const hydratedBooking = {
    ...booking,
    start_time: booking?.start_time || booking?.picked_start || null,
    end_time: booking?.end_time || booking?.picked_end || null,
  };

  // 1) cancelación explícita (aunque no haya respondido yes/no)
  if (wantsToCancel(userText)) {
    return {
      handled: true,
      reply:
        idioma === "en"
          ? "Of course, no problem. I’ll stop the process for now. Whenever you’re ready, just tell me."
          : "Claro, no hay problema. Detengo todo por ahora. Cuando estés listo, solo avísame.",
      ctxPatch: { booking: { step: "idle" }, booking_last_touch_at: Date.now() },
    };
  }

  // 2) si no respondió yes/no
  if (!yes && !no) {
    return {
      handled: true,
      reply: idioma === "en" ? "Please reply YES to confirm or NO to cancel." : "Responde SI para confirmar o NO para cancelar.",
      ctxPatch: { booking: hydratedBooking, booking_last_touch_at: Date.now() },
    };
  }

  // 3) NO -> volver a pedir fecha/hora (preservando datos)
  if (no) {
    return {
      handled: true,
      reply:
        idioma === "en"
          ? "No problem. Send me another date and time (YYYY-MM-DD HH:mm)."
          : "Perfecto. Envíame otra fecha y hora (YYYY-MM-DD HH:mm).",
      ctxPatch: {
        booking: {
          ...booking,
          step: "ask_datetime",
          timeZone: hydratedBooking?.timeZone || timeZone,
          name: booking?.name || null,
          email: booking?.email || null,
          purpose: booking?.purpose || null,
          start_time: null,
          end_time: null,
          date_only: null,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // ✅ 4) YES -> antes de reservar, pedir datos faltantes (nombre/email)
if (yes) {
  const missingName = !hydratedBooking?.name;
  const missingEmail = !hydratedBooking?.email;

  // Si falta el nombre, pídelo primero (aunque también falte email)
  if (missingName) {
    return {
      handled: true,
      reply:
        idioma === "en"
          ? "Perfect. Before I confirm it, what’s your full name?"
          : "Perfecto. Antes de confirmarla, ¿cuál es tu nombre completo?",
      ctxPatch: {
        booking: {
          ...hydratedBooking,
          step: "ask_name",
          timeZone: hydratedBooking?.timeZone || timeZone,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // Si ya hay nombre pero falta email
  if (missingEmail) {
    return {
      handled: true,
      reply:
        idioma === "en"
          ? "Thanks. What’s your email? (example: name@email.com)"
          : "Gracias. ¿Cuál es tu email? (ej: nombre@email.com)",
      ctxPatch: {
        booking: {
          ...hydratedBooking,
          step: "ask_email",
          timeZone: hydratedBooking?.timeZone || timeZone,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }
}

  // 5) YES pero sin start/end
const startISO = hydratedBooking?.start_time;
const endISO = hydratedBooking?.end_time;

if (!startISO || !endISO) {
  return {
    handled: true,
    reply:
      idioma === "en"
        ? "Send me the date and time (YYYY-MM-DD HH:mm)."
        : "Envíame la fecha y hora (YYYY-MM-DD HH:mm).",
    ctxPatch: { booking: { ...hydratedBooking, step: "ask_datetime" }, booking_last_touch_at: Date.now() },
  };
}

  // 6) crear appointment pending idempotente (dedupe real)
  const customer_name = hydratedBooking?.name || "Cliente";

  const pending = await createPendingAppointmentOrGetExisting({
    tenantId,
    channel: canal,
    customer_name,
    customer_phone: contacto,
    customer_email: hydratedBooking.email,
    start_time: startISO,
    end_time: endISO,
  });

  if (!pending) {
    return {
      handled: true,
      reply: idioma === "en" ? "Something went wrong creating your booking. Please try again." : "Ocurrió un problema creando la reserva. Por favor intenta de nuevo.",
      ctxPatch: { booking: { step: "ask_datetime", timeZone }, booking_last_touch_at: Date.now() },
    };
  }

  // 6) si ya estaba confirmado, responde idempotente
  if (pending.status === "confirmed" && pending.google_event_link) {
    return {
      handled: true,
      reply: idioma === "en" ? `Already booked. ${pending.google_event_link}`.trim() : `Ya quedó agendado. ${pending.google_event_link}`.trim(),
      ctxPatch: { booking: { step: "idle" }, booking_last_touch_at: Date.now() },
    };
  }

  // 7) si google no conectado, salir limpio
  if (!googleConnected) {
    return {
      handled: true,
      reply: idioma === "en" ? "Scheduling isn’t available for this business right now." : "El agendamiento no está disponible en este momento para este negocio.",
      ctxPatch: { booking: { step: "idle" }, booking_last_touch_at: Date.now() },
    };
  }

  // 8) intentar reservar en Google
  const g = await bookInGoogle({
    tenantId,
    customer_name,
    customer_phone: contacto,
    customer_email: hydratedBooking.email,
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

    const err = String((g as any)?.error || "");

    // SLOT_BUSY -> ofrecer alternativas del mismo día
    if (err === "SLOT_BUSY") {
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
              booking: { ...hydratedBooking, step: "offer_slots", timeZone, slots },
              booking_last_touch_at: Date.now(),
            },
          };
        }
      }
    }

    if (err === "PAST_SLOT") {
      return {
        handled: true,
        reply:
          idioma === "en"
            ? "That date/time is in the past. Please send a future date and time (YYYY-MM-DD HH:mm)."
            : "Esa fecha/hora ya pasó. Envíame una fecha y hora futura (YYYY-MM-DD HH:mm).",
        ctxPatch: { booking: { step: "ask_datetime", timeZone }, booking_last_touch_at: Date.now() },
      };
    }

    if (err === "OUTSIDE_BUSINESS_HOURS") {
      return {
        handled: true,
        reply:
          idioma === "en"
            ? "That time is outside business hours. Please choose a different time."
            : "Ese horario está fuera del horario de atención. Elige otro horario.",
        ctxPatch: { booking: { step: "ask_datetime", timeZone }, booking_last_touch_at: Date.now() },
      };
    }

    return {
      handled: true,
      reply:
        idioma === "en"
          ? "That time doesn’t seem to be available. Could you send me another date and time? (YYYY-MM-DD HH:mm)"
          : "Ese horario ya no está disponible. ¿Me compartes otra fecha y hora? (YYYY-MM-DD HH:mm)",
      ctxPatch: { booking: { step: "ask_datetime", timeZone }, booking_last_touch_at: Date.now() },
    };
  }

  // 9) confirmado
  await markAppointmentConfirmed({
    apptId: pending.id,
    google_event_id: g.event_id ?? null,
    google_event_link: g.htmlLink ?? null,
  });

  const apptId = pending.id;

  return {
    handled: true,
    reply:
      idioma === "en"
        ? `You're all set — your appointment is confirmed. ${g.htmlLink || ""}`.trim()
        : `Perfecto, tu cita quedó confirmada. ${g.htmlLink || ""}`.trim(),
    ctxPatch: {
      booking: { step: "idle" },
      last_appointment_id: apptId,
      booking_completed: true,
      booking_completed_at: new Date().toISOString(),
      booking_last_done_at: Date.now(),
      booking_last_event_link: g.htmlLink || null,
      booking_last_touch_at: Date.now(),
    },
  };
}
