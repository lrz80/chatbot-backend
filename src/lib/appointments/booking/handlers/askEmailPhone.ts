// src/lib/appointments/booking/handlers/askEmailPhone.ts
import { parseEmail, parsePhone } from "../text";
import { formatSlotHuman } from "../time";

export type AskEmailPhoneDeps = {
  tenantId: string;
  canal: string;
  contacto: string;
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
    contacto: string;
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
    contacto,
    idioma,
    userText,
    booking,
    timeZone,
    wantsToChangeTopic,
    wantsToCancel,
    requirePhone,
    upsertClienteBookingData,
  } = deps;

  if (wantsToChangeTopic(userText)) {
    return { handled: false, ctxPatch: { booking: { step: "idle" } } };
  }

  if (wantsToCancel(userText)) {
    return {
      handled: true,
      reply:
        idioma === "en"
          ? "No worries, whenever you’re ready to schedule, I’ll be here to help."
          : "No hay problema, cuando necesites agendar estaré aquí para ayudarte.",
      ctxPatch: { booking: { step: "idle" }, booking_last_touch_at: Date.now() },
    };
  }

  // ✅ Capturar ambos en el MISMO mensaje
  const email = parseEmail(userText);
  const phone = parsePhone(userText);

  // Email es obligatorio siempre
  if (!email) {
    return {
      handled: true,
      reply:
        idioma === "en"
          ? "Send your email and phone in ONE message Please! (example: name@email.com, +1 305 555 1234)."
          : "Por favor Envíame tu email y tu teléfono en UN solo mensaje (ej: nombre@email.com, +1 305 555 1234).",
      ctxPatch: {
        booking: { ...booking, step: "ask_email_phone" },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // Teléfono obligatorio solo si requirePhone (IG/FB)
  if (requirePhone && !phone) {
    return {
      handled: true,
      reply:
        idioma === "en"
          ? "I got your email. Now send your phone with country code (example: +1 305 555 1234)."
          : "Ya tengo tu email. Ahora envíame tu teléfono con código de país (ej: +1 305 555 1234).",
      ctxPatch: {
        booking: { ...booking, step: "ask_email_phone", email },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  const name = booking?.name || null;
  if (!name) {
    // Si por algún motivo llegamos aquí sin nombre, volvemos a pedirlo.
    return {
      handled: true,
      reply:
        idioma === "en"
          ? "Before confirming, what is your first and last name? (example: John Smith)"
          : "Antes de confirmar, ¿cuál es tu nombre y apellido? (ej: Juan Pérez)",
      ctxPatch: { booking: { ...booking, step: "ask_name" }, booking_last_touch_at: Date.now() },
    };
  }

  const startISO = booking?.picked_start || booking?.start_time || null;
  const endISO = booking?.picked_end || booking?.end_time || null;

  if (!startISO || !endISO) {
    return { handled: false, ctxPatch: { booking: { step: "idle" } } };
  }

  // ✅ Guardar en DB
  await upsertClienteBookingData({
    tenantId,
    canal,
    contacto,
    nombre: name,
    email,
    telefono: phone || null,
  });

  const whenTxt = formatSlotHuman({ startISO, timeZone, idioma });

  // ✅ Mensaje final sin loops
  return {
    handled: true,
    reply:
      idioma === "en"
        ? `Perfect. Confirm booking for ${whenTxt}? Reply YES to confirm or NO to cancel.`
        : `Perfecto. Confirmo tu cita para ${whenTxt}. Responde SI para confirmar o NO para cancelar.`,
    ctxPatch: {
      booking: {
        ...booking,
        step: "confirm",
        timeZone,
        email,
        phone: phone || null,
        start_time: startISO,
        end_time: endISO,
        picked_start: null,
        picked_end: null,
      },
      booking_last_touch_at: Date.now(),
    },
  };
}
