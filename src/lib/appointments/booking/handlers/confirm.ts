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

  minLeadMinutes: number;

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
    minLeadMinutes,
    googleConnected,
    createPendingAppointmentOrGetExisting,
    markAppointmentFailed,
    markAppointmentConfirmed,
    bookInGoogle,
  } = deps;

  const t = String(userText || "").trim().toLowerCase();
  const yes = /^(si|sí|yes|y)$/i.test(t);
  const no = /^(no|n)$/i.test(t);

  console.log("🧨 [CONFIRM ENTER]", {
    tenantId,
    canal,
    contacto,
    userText,
    yes,
    no,
    step: booking?.step,
    booking_name: booking?.name,
    booking_email: booking?.email,
    booking_phone: booking?.phone,
    booking_start: booking?.start_time,
    booking_end: booking?.end_time,
    picked_start: booking?.picked_start,
    picked_end: booking?.picked_end,
  });

  // ✅ Hydrate start/end desde picked_* por seguridad
  const hydratedBooking = {
    ...booking,
    timeZone: booking?.timeZone || timeZone,
    lang: (booking?.lang as any) || idioma, // ✅ sticky
    start_time: booking?.start_time || booking?.picked_start || null,
    end_time: booking?.end_time || booking?.picked_end || null,
  };

  const effectiveLang: "es" | "en" = (hydratedBooking?.lang as any) || idioma;
  const tz = hydratedBooking.timeZone;

  // 1) cancelación explícita (aunque no haya respondido yes/no)
  if (wantsToCancel(userText)) {
    return {
      handled: true,
      reply:
        effectiveLang === "en"
          ? "Of course, no problem. I’ll stop the process for now. Whenever you’re ready, just tell me."
          : "Claro, no hay problema. Detengo todo por ahora. Cuando estés listo, solo avísame.",
      ctxPatch: { booking: { ...hydratedBooking, step: "idle" }, booking_last_touch_at: Date.now() },
    };
  }

  // 2) si no respondió yes/no
  if (!yes && !no) {
    return {
      handled: true,
      reply: effectiveLang === "en" ? "Please reply YES to confirm or NO to cancel." : "Responde SI para confirmar o NO para cancelar.",
      ctxPatch: {
        booking: {
          ...hydratedBooking,
          lang: (hydratedBooking?.lang as any) || idioma, // ✅
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // 3) NO -> volver a pedir fecha/hora (preservando datos)
  if (no) {
    return {
      handled: true,
      reply:
        effectiveLang === "en"
          ? "No problem. Send me another date and time (YYYY-MM-DD HH:mm)."
          : "Perfecto. Envíame otra fecha y hora (YYYY-MM-DD HH:mm).",
      ctxPatch: {
        booking: {
          ...hydratedBooking,
          step: "ask_datetime",
          timeZone: tz,
          name: hydratedBooking?.name || null,
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

  const isMeta = canal === "facebook" || canal === "instagram";

  const clean = (v: any) => String(v ?? "").trim();

  const isJunk = (s: string) => {
    const t = s.trim().toLowerCase();
    return !t || t === "null" || t === "undefined" || t === "n/a" || t === "-";
  };

  const isValidEmail = (s: string) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(s.trim());

  const isValidName = (s: string) => {
    const t = s.trim();
    // mínimo 2 palabras o al menos 3 letras
    return t.length >= 3;
  };

  // ✅ 4) YES -> si faltan datos, SIEMPRE manda a ask_all (1 solo paso)
  if (yes) {
    const nameRaw = clean(hydratedBooking?.name);
    const emailRaw = clean(hydratedBooking?.email);
    const phoneRaw = clean(hydratedBooking?.phone);

    const missingName = isJunk(nameRaw) || !isValidName(nameRaw);
    const missingEmail = isJunk(emailRaw) || !isValidEmail(emailRaw);

    // WhatsApp NO pide phone; Meta sí
    const missingPhone = isMeta && (isJunk(phoneRaw) || phoneRaw.length < 7);

    console.log("🧨 [CONFIRM VALIDATE]", {
      tenantId,
      canal,
      yes,
      isMeta,
      nameRaw,
      emailRaw,
      phoneRaw,
      missingName,
      missingEmail,
      missingPhone,
    });

    if (missingName || missingEmail || missingPhone) {
      const example = isMeta
        ? (effectiveLang === "en"
            ? "John Smith, john@email.com, +13055551234"
            : "Juan Pérez, juan@email.com, +13055551234")
        : (effectiveLang === "en"
            ? "John Smith, john@email.com"
            : "Juan Pérez, juan@email.com");

      return {
        handled: true,
        reply:
          effectiveLang === "en"
            ? `Perfect. Before I book it, send ${isMeta ? "your full name, email, and phone" : "your full name and email"} in ONE message. Example: ${example}`
            : `Perfecto. Antes de agendarla, envíame ${isMeta ? "tu nombre completo, email y teléfono" : "tu nombre completo y tu email"} en *un solo mensaje*. Ej: ${example}`,
        ctxPatch: {
          booking: {
            ...hydratedBooking,
            step: "ask_all",
            timeZone: tz,
            // 🔥 limpia basura para que NO “pase” por tener strings raros
            name: missingName ? null : nameRaw,
            email: missingEmail ? null : emailRaw,
            phone: missingPhone ? null : phoneRaw,
            lang: (hydratedBooking?.lang as any) || idioma,
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
      effectiveLang === "en"
        ? "Send me the date and time (YYYY-MM-DD HH:mm)."
        : "Envíame la fecha y hora (YYYY-MM-DD HH:mm).",
    ctxPatch: {
      booking: {
        ...hydratedBooking,
        step: "ask_datetime",
        lang: (hydratedBooking?.lang as any) || idioma, // ✅
      },
      booking_last_touch_at: Date.now(),
    },
  };
}

  // ✅ Teléfono definitivo por canal:
  // - WhatsApp: `contacto` ya ES el teléfono
  // - IG/FB: `booking.phone` (capturado en ask_all)
  const customerPhone = isMeta
    ? String(hydratedBooking?.phone || "").trim()
    : String(contacto || "").trim();

  // 6) crear appointment pending idempotente (dedupe real)
  const customer_name = clean(hydratedBooking?.name);
  const customer_email_clean = clean(hydratedBooking?.email);

  if (isJunk(customer_name) || !isValidName(customer_name) || isJunk(customer_email_clean) || !isValidEmail(customer_email_clean)) {
    return {
      handled: true,
      reply: effectiveLang === "en"
        ? "Before confirming, please send your full name and email in one message."
        : "Antes de confirmar, envíame tu nombre completo y tu email en un solo mensaje.",
      ctxPatch: { booking: { ...hydratedBooking, step: "ask_all" }, booking_last_touch_at: Date.now() },
    };
  }

  const customerEmail = customer_email_clean || null;


  // ✅ Teléfono real:
  // - WhatsApp: contacto ES el teléfono
  // - IG/FB: contacto es senderId, el teléfono viene de booking.phone

  console.log("🧨 [CONFIRM PASS HARDGATE]", {
    tenantId,
    canal,
    customer_name,
    customer_email_clean,
    customerPhone,
    startISO,
    endISO,
  });

  const pending = await createPendingAppointmentOrGetExisting({
    tenantId,
    channel: canal,
    customer_name,
    customer_phone: customerPhone || undefined,
    customer_email: customerEmail || undefined,
    start_time: startISO,
    end_time: endISO,
  });

  if (!pending) {
    return {
      handled: true,
      reply: effectiveLang === "en" ? "Something went wrong creating your booking. Please try again." : "Ocurrió un problema creando la reserva. Por favor intenta de nuevo.",
      ctxPatch: {
        booking: {
          ...hydratedBooking,
          step: "ask_datetime",
          timeZone: tz,
          start_time: null,
          end_time: null,
          date_only: null,
          lang: (hydratedBooking?.lang as any) || idioma,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // 7) si ya estaba confirmado, responde idempotente
  if (pending.status === "confirmed" && pending.google_event_link) {
    return {
      handled: true,
      reply: effectiveLang === "en" ? `Already booked. ${pending.google_event_link}`.trim() : `Ya quedó agendado. ${pending.google_event_link}`.trim(),
      ctxPatch: { booking: { ...hydratedBooking, step: "idle" }, booking_last_touch_at: Date.now() },
    };
  }

  // 8) si google no conectado, salir limpio
  if (!googleConnected) {
    return {
      handled: true,
      reply: effectiveLang === "en" ? "Scheduling isn’t available for this business right now." : "El agendamiento no está disponible en este momento para este negocio.",
      ctxPatch: { booking: { ...hydratedBooking, step: "idle" }, booking_last_touch_at: Date.now() },
    };
  }

  console.log("🧾 [CONFIRM] booking attempt", {
    tenantId,
    canal,
    contacto,
    tz,
    startISO,
    endISO,
    name: customer_name,
    email: customerEmail,
    phone: customerPhone,
  });
console.log("🟣🟣🟣 CONFIRM VERSION: 2026-01-30-A (before bookInGoogle)", {
  tenantId,
  canal,
  contacto,
  startISO,
  endISO,
});

  // 9) intentar reservar en Google
    const g = await bookInGoogle({
    tenantId,
    customer_name,
    customer_phone: customerPhone || null,
    customer_email: customerEmail || null,
    startISO,
    endISO,
    timeZone: tz,
    bufferMin,
  });
console.log("🟣🟣🟣 CONFIRM VERSION: 2026-01-30-A (after bookInGoogle)", {
  ok: g?.ok,
  event_id: (g as any)?.event_id,
  htmlLink: (g as any)?.htmlLink,
  error: (g as any)?.error,
});

  if (!g.ok) {
    const err = String((g as any)?.error || "GOOGLE_ERROR");

    // ✅ NO guardar "failed" cuando solo es "hora no disponible"
    if (err !== "PAST_SLOT") {
        await markAppointmentFailed({
        apptId: pending.id,
        error_reason: err,
        });
    }

    // SLOT_BUSY -> ofrecer alternativas del mismo día
    if (err === "SLOT_BUSY") {
      const day = DateTime.fromISO(startISO, { zone: tz });
      const dateISO = day.isValid ? day.toFormat("yyyy-MM-dd") : null;

      if (dateISO) {
        const slots = await getSlotsForDate({
          tenantId,
          timeZone: tz,
          dateISO,
          durationMin,
          bufferMin,
          hours,
          minLeadMinutes,
        });

        if (slots.length) {
          const take = slots.slice(0, 5);
          return {
            handled: true,
            reply: renderSlotsMessage({ idioma: effectiveLang, timeZone: tz, slots: take, style: "closest" }),
            ctxPatch: {
              booking: {
                ...hydratedBooking,
                step: "offer_slots",
                timeZone: tz,
                slots: take,
                date_only: dateISO,
                last_offered_date: dateISO,
                // 🔥 limpia el slot que ya no sirve
                start_time: null,
                end_time: null,
                picked_start: null,
                picked_end: null,
                lang: (hydratedBooking?.lang as any) || idioma,
              },
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
          effectiveLang === "en"
            ? "That date/time isn’t available. Please send a future date and time (YYYY-MM-DD HH:mm)."
            : "Esa fecha/hora no esta disponible. Envíame una fecha y hora futura (YYYY-MM-DD HH:mm).",
        ctxPatch: {
          booking: {
            ...hydratedBooking,
            step: "ask_datetime",
            timeZone: tz,
            start_time: null,
            end_time: null,
            date_only: null,
            lang: (hydratedBooking?.lang as any) || idioma,
          },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    if (err === "OUTSIDE_BUSINESS_HOURS") {
      return {
        handled: true,
        reply:
          effectiveLang === "en"
            ? "That time isn’t available. Please choose a different time."
            : "Ese horario no está disponible. Elige otro horario.",
        ctxPatch: {
          booking: {
            ...hydratedBooking,
            step: "ask_datetime",
            timeZone: tz,
            start_time: null,
            end_time: null,
            date_only: null,
            lang: (hydratedBooking?.lang as any) || idioma,
          },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    return {
      handled: true,
      reply:
        effectiveLang === "en"
          ? "That time doesn’t seem to be available. Could you send me another date and time? (YYYY-MM-DD HH:mm)"
          : "Ese horario ya no está disponible. ¿Me compartes otra fecha y hora? (YYYY-MM-DD HH:mm)",
      ctxPatch: {
        booking: {
          ...hydratedBooking,
          step: "ask_datetime",
          timeZone: tz,
          start_time: null,
          end_time: null,
          date_only: null,
          lang: (hydratedBooking?.lang as any) || idioma,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // ✅ Hard check: sin link/id = NO confirmado
    const link = String(g.htmlLink || "").trim();
    const gid = String(g.event_id || "").trim();

    if (!link || !gid) {
    await markAppointmentFailed({
        apptId: pending.id,
        error_reason: "CREATE_EVENT_FAILED",
    });

    return {
        handled: true,
        reply:
        effectiveLang === "en"
            ? "I tried to book it, but Google Calendar didn’t confirm the event. Please try again."
            : "Intenté agendarla, pero Google Calendar no confirmó el evento. Intenta de nuevo enviando otra fecha y hora (YYYY-MM-DD HH:mm).",
        ctxPatch: {
        booking: {
            ...hydratedBooking,
            step: "ask_datetime",
            timeZone: tz,
            start_time: null,
            end_time: null,
            date_only: null,
            lang: (hydratedBooking?.lang as any) || idioma,
        },
        booking_last_touch_at: Date.now(),
        },
    };
    }

    // ✅ Ya sí: confirmado real
    await markAppointmentConfirmed({
    apptId: pending.id,
    google_event_id: gid,
    google_event_link: link,
    });

    const apptId = pending.id;

    return {
    handled: true,
    reply:
        effectiveLang === "en"
        ? `You're all set — your appointment is confirmed. ${link}`.trim()
        : `Perfecto, tu cita quedó confirmada. ${link}`.trim(),
    ctxPatch: {
        booking: { step: "idle" },
        last_appointment_id: apptId,
        booking_completed: true,
        booking_completed_at: new Date().toISOString(),
        booking_last_done_at: Date.now(),
        booking_last_event_link: link,
        booking_last_touch_at: Date.now(),
    },
    };
}
