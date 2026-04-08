// src/lib/appointments/booking/handlers/confirm.ts
import { DateTime } from "luxon";
import { wantsToCancel } from "../text";
import { renderSlotsMessage } from "../time";
import { getSlotsForDate } from "../slots";
import { cancelAppointmentById } from "../../cancelAppointment";
import type { LangCode } from "../../../i18n/lang";
import { toCanonicalLangOrFallback } from "../../../i18n/lang";

type ConfirmDeps = {
  tenantId: string;
  canal: string;
  contacto: string;
  idioma: LangCode;
  userText: string;

  booking: any; // BookingCtx.booking
  timeZone: string;

  durationMin: number;
  bufferMin: number;
  hours: any | null;

  minLeadMinutes: number;

  providerAvailable: boolean;

  // ✅ nuevo: cómo quiere el tenant que se mande el link
  bookingLinkMode: "meet" | "calendar";

  // DB + side-effects (se inyectan)
  createPendingAppointmentOrGetExisting: (args: {
    tenantId: string;
    channel: string;
    customer_name: string;
    customer_phone?: string;
    customer_email?: string;
    start_time: string;
    end_time: string;
    idempotency_key: string;
  }) => Promise<any | null>;

  markAppointmentFailed: (args: {
    apptId: string;
    error_reason: string;
  }) => Promise<void>;

  markAppointmentConfirmed: (args: {
    apptId: string;
    google_event_id: string | null;
    google_event_link: string | null;
  }) => Promise<void>;

  createExternalBooking: (args: {
    tenantId: string;
    customer_name: string;
    customer_phone?: string | null;
    customer_email?: string | null;
    startISO: string;
    endISO: string;
    timeZone: string;
    bufferMin: number;
  }) => Promise<{
    ok: boolean;
    event_id?: string | null;
    htmlLink?: string | null;
    meetLink?: string | null;
    error?: string;
    busy?: any[];
  }>;
};

function buildIdempotencyKey(args: {
  tenantId: string;
  channel: string;
  customerPhone: string;  // ✅ teléfono real (WA=contacto, Meta=booking.phone)
  startISO: string;
  endISO: string;
}) {
  const { tenantId, channel, customerPhone, startISO, endISO } = args;

  const phone = String(customerPhone || "").trim();
  const s = String(startISO || "").trim();
  const e = String(endISO || "").trim();

  // key estable por slot + cliente (no por senderId)
  return `appt:${tenantId}:${channel}:${phone}:${s}:${e}`;
}

function resetBooking(tz: string, lang: LangCode) {
  return {
    step: "idle",
    timeZone: tz,
    lang,
    name: null,
    email: null,
    phone: null,
    purpose: null,
    start_time: null,
    end_time: null,
    picked_start: null,
    picked_end: null,
    date_only: null,
    slots: null,
    last_offered_date: null,
  };
}

function normalizePhone(raw: any) {
  // conserva + al inicio si existe; elimina todo lo demás
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const hasPlus = s.startsWith("+");
  const digits = s.replace(/[^\d]/g, "");
  return (hasPlus ? "+" : "") + digits;
}

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
    providerAvailable,
    createPendingAppointmentOrGetExisting,
    markAppointmentFailed,
    markAppointmentConfirmed,
    createExternalBooking,
    bookingLinkMode, 
  } = deps;

  const t = String(userText || "").trim().toLowerCase();

  const resolvedLang = toCanonicalLangOrFallback(
    booking?.lang || idioma,
    "en"
  );

  const hydratedBooking = {
    ...booking,
    timeZone: booking?.timeZone || timeZone,
    lang: resolvedLang,

    start_time: booking?.picked_start || booking?.start_time || null,
    end_time: booking?.picked_end || booking?.end_time || null,
  };

  const effectiveLang: LangCode = hydratedBooking.lang;
  const tz = hydratedBooking.timeZone;

  const yesValues = new Set(["yes", "y"]);
  const noValues = new Set(["no", "n"]);

  if (effectiveLang === "es") {
    yesValues.add("si");
    yesValues.add("sí");
  }

  const yes = yesValues.has(t);
  const no = noValues.has(t);

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

  // ⭐⭐⭐ NUEVO: cita desde la que estamos reprogramando (si aplica)
  const rescheduleFromApptId = booking?.reschedule_from_appt_id
    ? String(booking.reschedule_from_appt_id).trim()
    : null;

  const locked = !!hydratedBooking?.picked_start && !!hydratedBooking?.picked_end;

  if (locked) {
    // si alguien dejó start_time distinto a picked_start, lo corregimos aquí
    if (hydratedBooking.start_time !== hydratedBooking.picked_start || hydratedBooking.end_time !== hydratedBooking.picked_end) {
      hydratedBooking.start_time = hydratedBooking.picked_start;
      hydratedBooking.end_time = hydratedBooking.picked_end;
    }
  }

  // 1) cancelación explícita (aunque no haya respondido yes/no)
  if (wantsToCancel(userText)) {
    return {
      handled: true,
      reply:
        effectiveLang === "es"
          ? "Claro, no hay problema. Detengo todo por ahora. Cuando estés listo, solo avísame."
          : "Of course, no problem. I’ll stop the process for now. Whenever you’re ready, just tell me.",
      ctxPatch: { booking: resetBooking(tz, effectiveLang), booking_last_touch_at: Date.now() }
    };
  }

  // 2) si no respondió yes/no
  if (!yes && !no) {
    return {
      handled: true,
        reply:
          effectiveLang === "es"
            ? "Responde SI para confirmar o NO para cancelar."
            : "Please reply YES to confirm or NO to cancel.",
      ctxPatch: {
        booking: {
          ...hydratedBooking,
          lang: effectiveLang,
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
        effectiveLang === "es"
          ? "Listo — cancelado. Si quieres agendar otro horario, envíame la fecha y hora (YYYY-MM-DD HH:mm)."
          : "Okay — canceled. If you want to book another time, just send the date and time (YYYY-MM-DD HH:mm).",
      ctxPatch: {
        booking: resetBooking(tz, effectiveLang),
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
    const phoneNorm = normalizePhone(phoneRaw);
    const missingPhone = isMeta && (isJunk(phoneRaw) || phoneNorm.replace(/[^\d]/g, "").length < 7);

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
        ? (effectiveLang === "es"
            ? "Juan Pérez, juan@email.com, +13055551234"
            : "John Smith, john@email.com, +13055551234")
        : (effectiveLang === "es"
            ? "Juan Pérez, juan@email.com"
            : "John Smith, john@email.com")
          
      return {
        handled: true,
        reply:
          effectiveLang === "es"
            ? `Perfecto. Antes de agendarla, envíame ${isMeta ? "tu nombre completo, email y teléfono" : "tu nombre completo y tu email"} en un solo mensaje. Ej: ${example}`
            : `Perfect. Before I book it, send ${isMeta ? "your full name, email, and phone" : "your full name and email"} in one message. Example: ${example}`,
        ctxPatch: {
          booking: {
            ...hydratedBooking,
            step: "ask_all",
            timeZone: tz,
            // 🔥 limpia basura para que NO “pase” por tener strings raros
            name: missingName ? null : nameRaw,
            email: missingEmail ? null : emailRaw,
            phone: missingPhone ? null : phoneNorm,
            lang: effectiveLang,
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
      effectiveLang === "es"
        ? "Envíame la fecha y hora (YYYY-MM-DD HH:mm)."
        : "Send me the date and time (YYYY-MM-DD HH:mm).",
    ctxPatch: {
      booking: {
        ...hydratedBooking,
        step: "ask_datetime",
        lang: effectiveLang,
      },
      booking_last_touch_at: Date.now(),
    },
  };
}

  // ✅ Teléfono definitivo por canal:
  // - WhatsApp: `contacto` ya ES el teléfono
  // - IG/FB: `booking.phone` (capturado en ask_all)
  const customerPhoneRaw = isMeta
    ? String(hydratedBooking?.phone || "").trim()
    : String(contacto || "").trim();

  const customerPhone = normalizePhone(customerPhoneRaw);

  // 6) crear appointment pending idempotente (dedupe real)
  const customer_name = clean(hydratedBooking?.name);
  const customer_email_clean = clean(hydratedBooking?.email);

  if (isJunk(customer_name) || !isValidName(customer_name) || isJunk(customer_email_clean) || !isValidEmail(customer_email_clean)) {
    return {
      handled: true,
      reply: effectiveLang === "es"
        ? "Antes de confirmar, envíame tu nombre completo y tu email en un solo mensaje."
        : "Before confirming, please send your full name and email in one message.",
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

  const idempotency_key = buildIdempotencyKey({
    tenantId,
    channel: canal,
    customerPhone,     // ✅ NO contacto
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
    idempotency_key,
  });

  if (!pending) {
    return {
      handled: true,
      reply: effectiveLang === "es" ? "Ocurrió un problema creando la reserva. Por favor intenta de nuevo." : "Something went wrong creating your booking. Please try again.",
      ctxPatch: {
        booking: {
          ...hydratedBooking,
          step: "ask_datetime",
          timeZone: tz,
          start_time: null,
          end_time: null,
          date_only: null,
          lang: effectiveLang,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // 7) si ya estaba confirmado, responde idempotente
  const sameSlot =
    String(pending.start_time || "") === String(startISO) &&
    String(pending.end_time || "") === String(endISO);

  if (pending.status === "confirmed" && pending.google_event_link && sameSlot) {
    return {
      handled: true,
      reply: effectiveLang === "es"
        ? `Ya quedó agendado para ese horario. ${pending.google_event_link}`.trim()
        : `Already booked for that time. ${pending.google_event_link}`.trim(),
      ctxPatch: {
        booking: { step: "idle" },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // Si está confirmed pero NO es el mismo slot, NO bloquees.
  
  // 8) si no hay provider disponible, salir limpio
  if (!providerAvailable) {
    return {
      handled: true,
      reply:
        effectiveLang === "es"
          ? "El agendamiento no está disponible en este momento para este negocio."
          : "Scheduling isn’t available for this business right now.",
      ctxPatch: {
        booking: resetBooking(tz, effectiveLang),
        booking_last_touch_at: Date.now(),
      },
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

  console.log("🟣🟣🟣 CONFIRM VERSION: 2026-01-30-A (before createExternalBooking)", {
    tenantId,
    canal,
    contacto,
    startISO,
    endISO,
  });

  // 9) intentar reservar con el provider configurado
  const bookingResult = await createExternalBooking({
    tenantId,
    customer_name,
    customer_phone: customerPhone || null,
    customer_email: customerEmail || null,
    startISO,
    endISO,
    timeZone: tz,
    bufferMin,
  });

  if (!bookingResult.ok) {
    const err = String(bookingResult?.error || "BOOKING_PROVIDER_ERROR");

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
          const take = slots.slice(0, 3);
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
                lang: effectiveLang,
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
          effectiveLang === "es"
            ? "Esa fecha/hora no esta disponible. Envíame una fecha y hora futura (YYYY-MM-DD HH:mm)."
            : "That date/time isn’t available. Please send a future date and time (YYYY-MM-DD HH:mm).",
        ctxPatch: {
          booking: {
            ...hydratedBooking,
            step: "ask_datetime",
            timeZone: tz,
            start_time: null,
            end_time: null,
            date_only: null,
            lang: effectiveLang,
          },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    if (err === "OUTSIDE_BUSINESS_HOURS") {
      return {
        handled: true,
        reply:
          effectiveLang === "es"
            ? "Ese horario no está disponible. Elige otro horario."
            : "That time isn’t available. Please choose a different time.",
        ctxPatch: {
          booking: {
            ...hydratedBooking,
            step: "ask_datetime",
            timeZone: tz,
            start_time: null,
            end_time: null,
            date_only: null,
            lang: effectiveLang,
          },
          booking_last_touch_at: Date.now(),
        },
      };
    }

    return {
      handled: true,
      reply:
        effectiveLang === "es"
          ? "Ese horario ya no está disponible. ¿Me compartes otra fecha y hora? (YYYY-MM-DD HH:mm)"
          : "That time doesn’t seem to be available. Could you send me another date and time? (YYYY-MM-DD HH:mm)",
      ctxPatch: {
        booking: {
          ...hydratedBooking,
          step: "ask_datetime",
          timeZone: tz,
          start_time: null,
          end_time: null,
          date_only: null,
          lang: effectiveLang,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // ✅ Hard check: sin link/id = NO confirmado
  const link = String(bookingResult.htmlLink || "").trim();
  const gid = String(bookingResult.event_id || "").trim();
  const meet = String(bookingResult.meetLink || "").trim();

  if (!link || !gid) {
    await markAppointmentFailed({
        apptId: pending.id,
        error_reason: "CREATE_EVENT_FAILED",
    });

    return {
      handled: true,
      reply: effectiveLang === "es"
        ? "No pude confirmar la cita. Envíame una nueva fecha y hora (YYYY-MM-DD HH:mm)."
        : "I couldn’t confirm the booking. Please send a new date and time (YYYY-MM-DD HH:mm).",
      ctxPatch: {
        booking: resetBooking(tz, effectiveLang),
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // ✅ Ya sí: confirmado real
  await markAppointmentConfirmed({
    apptId: pending.id,
    google_event_id: gid,
    google_event_link: meet || link,
  });

  const apptId = pending.id;

  // ⭐⭐⭐ NUEVO: si venimos de reprogramar, cancela la cita anterior
  if (rescheduleFromApptId && rescheduleFromApptId !== String(apptId)) {
    try {
      const cancelRes = await cancelAppointmentById({
        tenantId,
        appointmentId: rescheduleFromApptId,
      });

      console.log("[BOOKING] reschedule: canceled previous appt", {
        tenantId,
        from: rescheduleFromApptId,
        to: apptId,
        cancelOk: cancelRes.ok,
        cancelError: cancelRes.error,
      });
    } catch (e: any) {
      console.warn("[BOOKING] reschedule: failed to cancel previous appt", {
        tenantId,
        from: rescheduleFromApptId,
        to: apptId,
        error: e?.message || e,
      });
      // 👈 Importante: NO lanzamos error.
      // La nueva cita ya quedó confirmada; solo falló borrar la vieja.
    }
  }

  // 👇 lógica multitenant de qué link se le muestra al cliente
  let publicLink: string | null = null;

  if (bookingLinkMode === "meet") {
    // Tenants que quieren Meet: si hay meet, usa meet; si no, cae a htmlLink
    publicLink = meet || link || null;
  } else {
    // Tenants que NO quieren Meet: usa siempre el link del evento
    publicLink = link || meet || null;
  }

  let replyText: string;

  if (publicLink) {
    replyText =
      effectiveLang === "es"
        ? `Perfecto, tu cita quedó confirmada. Aquí tienes el enlace de confirmación: ${publicLink}`
        : `You're all set — your appointment is confirmed. Here is your confirmation link: ${publicLink}`;
  } else {
    replyText =
      effectiveLang === "es"
        ? "Perfecto, tu cita quedó confirmada."
        : "You're all set — your appointment is confirmed.";
  }

  return {
    handled: true,
    reply: replyText,
    ctxPatch: {
      booking: resetBooking(tz, effectiveLang),

      last_appointment_id: apptId,
      last_appointment_google_event_id: gid,
      last_appointment_startISO: startISO,
      last_appointment_endISO: endISO,
      last_appointment_tz: tz,
      last_appointment_channel: canal,

      // Guardamos el link real (sea meet o calendar)
      booking_last_event_link: publicLink || meet || link,

      booking_completed: true,
      booking_completed_at: new Date().toISOString(),
      booking_last_done_at: Date.now(),
      booking_last_touch_at: Date.now(),
    },
  };
}
