// src/lib/appointments/booking/handlers/askEmailPhone.ts
import { parseEmail, parsePhone } from "../text";
import { formatSlotHuman } from "../time";

export type AskEmailPhoneDeps = {
  tenantId: string;
  canal: string;
  idioma: "es" | "en";
  userText: string;

  booking: any;
  timeZone: string;

  wantsToChangeTopic: (s: string) => boolean;
  wantsToCancel: (s: string) => boolean;

  requirePhone: boolean; // IG/FB true, WhatsApp false (pero igual lo aceptamos si viene)

  upsertClienteBookingData: (args: {
    tenantId: string;
    canal: string;
    nombre: string;
    email: string;
    telefono?: string | null;
  }) => Promise<any>;
};

export async function handleAskEmailPhone(deps: AskEmailPhoneDeps): Promise<{
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
    wantsToChangeTopic,
    wantsToCancel,
    requirePhone,
    upsertClienteBookingData,
  } = deps;

    const hydratedBooking = {
    ...booking,
    timeZone: booking?.timeZone || timeZone,
    lang: booking?.lang || idioma, // ✅ sticky lang
  };

  const effectiveLang: "es" | "en" = (hydratedBooking.lang as any) || idioma;
  const tz = hydratedBooking.timeZone;

  if (wantsToChangeTopic(userText)) {
    return { handled: false, ctxPatch: { booking: { ...hydratedBooking, step: "idle" } } };
  }

  if (wantsToCancel(userText)) {
    return {
      handled: true,
      reply:
        effectiveLang === "en"
          ? "No worries, whenever you’re ready to schedule, I’ll be here to help."
          : "No hay problema, cuando necesites agendar estaré aquí para ayudarte.",
      ctxPatch: { booking: { ...hydratedBooking, step: "idle" }, booking_last_touch_at: Date.now() },
    };
  }

  // ✅ Capturar ambos en el MISMO mensaje
  const email = parseEmail(userText);
  const parsedPhone = parsePhone(userText);

  // ✅ WhatsApp: usar booking.phone (ya lo seteas al inicio del flow)
  const waPhone =
    canal === "whatsapp" ? String(booking?.phone || "").trim() : "";

  const phone = parsedPhone || (waPhone ? waPhone : null);

  // Email es obligatorio siempre
  if (!email) {
    return {
      handled: true,
      reply:
        effectiveLang === "en"
          ? (requirePhone
              ? "Send your email and phone in ONE message please! (example: name@email.com, +1 305 555 1234)."
              : "Send your email in ONE message please! (example: name@email.com).")
          : (requirePhone
              ? "Por favor envíame tu email y tu teléfono en UN solo mensaje (ej: nombre@email.com, +1 305 555 1234)."
              : "Por favor envíame tu email en UN solo mensaje (ej: nombre@email.com)."),
      ctxPatch: {
        booking: { ...hydratedBooking, step: "ask_email_phone", timeZone: tz },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // Teléfono obligatorio solo si requirePhone (IG/FB)
  if (requirePhone && !phone) {
    return {
      handled: true,
      reply:
        effectiveLang === "en"
          ? "I got your email. Now send your phone with country code (example: +1 305 555 1234)."
          : "Ya tengo tu email. Ahora envíame tu teléfono con código de país (ej: +1 305 555 1234).",
      ctxPatch: {
        booking: { ...hydratedBooking, step: "ask_email_phone", timeZone: tz, email },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  const name = hydratedBooking?.name || null;
  if (!name) {
    // Si por algún motivo llegamos aquí sin nombre, volvemos a pedirlo.
    return {
      handled: true,
      reply:
        effectiveLang === "en"
          ? "Before confirming, what is your first and last name? (example: John Smith)"
          : "Antes de confirmar, ¿cuál es tu nombre y apellido? (ej: Juan Pérez)",
      ctxPatch: { booking: { ...hydratedBooking, step: "ask_name" }, booking_last_touch_at: Date.now() },
    };
  }

  const startISO = hydratedBooking?.picked_start || hydratedBooking?.start_time || null;
  const endISO   = hydratedBooking?.picked_end   || hydratedBooking?.end_time   || null;

  if (!startISO || !endISO) {
    return { handled: false, ctxPatch: { booking: { ...hydratedBooking, step: "idle" } } };
  }

  // ✅ Guardar en DB
  await upsertClienteBookingData({
    tenantId,
    canal,
    nombre: name,
    email,
    telefono: phone,
  });

  const whenTxt = formatSlotHuman({ startISO, timeZone: tz, idioma: effectiveLang });

  // ✅ Mensaje final sin loops
  return {
    handled: true,
    reply:
      effectiveLang === "en"
        ? `Perfect. Confirm booking for ${whenTxt}? Reply YES to confirm or NO to cancel.`
        : `Perfecto. Confirmo tu cita para ${whenTxt}. Responde SI para confirmar o NO para cancelar.`,
    ctxPatch: {
      booking: {
        ...hydratedBooking,
        step: "confirm",
        timeZone: tz,
        email,
        phone: phone || null,
        start_time: startISO,
        end_time: endISO,
      },
      booking_last_touch_at: Date.now(),
    },
  };
}
