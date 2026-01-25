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
  hasExplicitDateTime,
  hasAppointmentContext,
  isCapabilityQuestion,
  isDirectBookingRequest,
  detectPurpose,
  wantsToCancel,
  wantsToChangeTopic,
  matchesBookingIntent,
  parseFullName,
} from "./booking/text";
import { handleAskEmailPhone } from "./booking/handlers/askEmailPhone";

import {
  MIN_LEAD_MINUTES,
  parseDateTimeExplicit,
  isWithinBusinessHours,
} from "./booking/time";
import { extractBusyBlocks } from "./booking/freebusy";
import { handleOfferSlots } from "./booking/handlers/offerSlots";
import { handleAskDatetime } from "./booking/handlers/askDatetime";
import { handleAskDaypart } from "./booking/handlers/askDaypart";
import { handleAskAll } from "./booking/handlers/askAll";
import { handleConfirm } from "./booking/handlers/confirm";
import { handleAskName } from "./booking/handlers/askName";
import { handleAskPurpose } from "./booking/handlers/askPurpose";
import { handleStartBooking } from "./booking/handlers/start";


const BOOKING_FLOW_TTL_MS = 30 * 60 * 1000; // 30 minutos (ajústalo a 15/60 si quieres)

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
  console.log("📅 [BOOKING] in", { tenantId, canal, contacto, messageId });

  const ctx = (opts.ctx && typeof opts.ctx === "object") ? (opts.ctx as BookingCtx) : {};
  const booking = ctx.booking || { step: "idle" as const };

  const nowMs = Date.now();

  // ✅ timestamp del último mensaje relacionado con booking
  const lastTouch = (ctx as any)?.booking_last_touch_at;
  const lastTouchMs = typeof lastTouch === "number" ? lastTouch : null;

  const bookingActive = booking?.step && booking.step !== "idle";

  // ✅ Expira si: estaba activo y pasó el TTL
  const bookingExpired =
    bookingActive &&
    lastTouchMs &&
    Number.isFinite(lastTouchMs) &&
    (nowMs - lastTouchMs) > BOOKING_FLOW_TTL_MS;

  if (bookingExpired) {
    console.log("📅 [BOOKING] expired -> reset", {
      tenantId,
      canal,
      contacto,
      prevStep: booking.step,
      minutes: Math.round((nowMs - lastTouchMs) / 60000),
    });

    // resetea wizard y deja pasar el mensaje actual al LLM
    return {
      handled: false,
      ctxPatch: {
        booking: { step: "idle" },
        booking_last_touch_at: null,
        // opcional: limpia rastros para evitar efectos raros
        last_appointment_id: null,
      },
    };
  }

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
      ctxPatch: { 
        booking: { step: "idle" }, 
        booking_last_touch_at: Date.now(),
      },
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
          booking_last_touch_at: Date.now(),
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
      ctxPatch: { 
        booking: { step: "idle" }, 
        booking_last_touch_at: Date.now(), },
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
        ctxPatch: { 
        booking: { step: "idle" }, 
        booking_last_touch_at: Date.now(), },
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
    ctxPatch: { 
        booking: { step: "idle" }, 
        booking_last_touch_at: Date.now(), },
    };
}

// 3) Si NO hay link y Google NO está conectado: no inicies flujo
if (wantsBooking && !bookingLink && !googleConnected) {
  return {
    handled: true,
    reply: idioma === "en"
      ? "Scheduling is unavailable right now."
      : "El agendamiento no está disponible en este momento.",
    ctxPatch: { 
        booking: { step: "idle" }, 
        booking_last_touch_at: Date.now(), },
  };
}

if (booking.step === "idle") {
  return handleStartBooking({
    idioma,
    userText,
    timeZone,
    wantsBooking,
    detectPurpose,
    durationMin,
  });
}

if (booking.step === "ask_purpose") {
  return handleAskPurpose({
    idioma,
    userText,
    booking,
    timeZone,
    tenantId,
    canal,
    wantsToChangeTopic,
    wantsToCancel,
    detectPurpose,
  });
}

if (booking.step === "ask_daypart") {
  return handleAskDaypart({
    tenantId,
    idioma,
    userText,
    booking,
    timeZone,
    durationMin,
    bufferMin,
    hours,
  });
}

if (booking.step === "ask_all") {
  return handleAskAll({
    tenantId,
    idioma,
    userText,
    booking,
    timeZone,
    durationMin,
    bufferMin,
    hours,
    parseDateTimeExplicit,
  });
}

if (booking.step === "ask_name") {
  return handleAskName({
    tenantId,
    canal,
    contacto,
    idioma,
    userText,
    booking,
    timeZone,
    wantsToChangeTopic,
    wantsToCancel,
    parseFullName,
    upsertClienteBookingData,
  });
}

if (booking.step === "offer_slots") {
  return handleOfferSlots({
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
  });
}

if (booking.step === "ask_email_phone") {
  const requirePhone = canal === "facebook" || canal === "instagram"; // IG/FB sí
  return handleAskEmailPhone({
    tenantId,
    canal,
    contacto,
    idioma,
    userText,
    booking,
    timeZone,
    wantsToChangeTopic,
    wantsToCancel,
    requirePhone,
    upsertClienteBookingData,
  });
}

  if (booking.step === "ask_datetime") {
    return handleAskDatetime({
      tenantId,
      canal,
      contacto,
      idioma,
      userText,
      booking,
      timeZone,
      durationMin,
      hours,
      parseDateTimeExplicit,
    });
  }

  if (booking.step === "confirm") {
    return handleConfirm({
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
    });
  }

  return { handled: false };
}
