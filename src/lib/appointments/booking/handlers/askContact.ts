// src/lib/appointments/booking/handlers/askContact.ts
import { formatSlotHuman } from "../time";
import { parsePhone } from "../text";

export type AskContactDeps = {
  tenantId: string;
  canal: string;
  contacto: string;
  idioma: "es" | "en";
  userText: string;

  booking: any;
  timeZone: string;

  wantsToChangeTopic: (s: string) => boolean;
  wantsToCancel: (s: string) => boolean;

  parseNameEmailOnly: (s: string) => { name?: string | null; email?: string | null };
  parseEmail: (s: string) => string | null;

  upsertClienteBookingData: (args: {
    tenantId: string;
    canal: string;
    contacto: string;
    nombre: string;
    email: string;
    telefono?: string | null;
  }) => Promise<any>;
};

export async function handleAskContact(deps: AskContactDeps): Promise<{
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
    parseNameEmailOnly,
    parseEmail,
    upsertClienteBookingData,
  } = deps;

  const isMeta = canal === "facebook" || canal === "instagram"; // ✅ IG/FB requiere teléfono

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
      ctxPatch: {
        booking: { step: "idle" },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  const { name, email } = parseNameEmailOnly(userText);

  if (!name) {
    return {
      handled: true,
      reply:
        idioma === "en"
          ? "I’m missing your first and last name (example: John Smith)."
          : "Me falta tu nombre y apellido (ej: Juan Pérez).",
      ctxPatch: {
        booking: { ...booking, step: "ask_contact" },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  if (!email || !parseEmail(email)) {
    return {
      handled: true,
      reply:
        idioma === "en"
          ? "I’m missing a valid email (example: name@email.com)."
          : "Me falta un email válido (ej: nombre@email.com).",
      ctxPatch: {
        booking: { ...booking, step: "ask_contact" },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  const phone = parsePhone(userText); // ✅ intenta extraer teléfono del mismo mensaje

  if (isMeta && !phone) {
    return {
      handled: true,
      reply:
        idioma === "en"
          ? "I’m missing your phone number (include country code). Example: +1 305 555 1234"
          : "Me falta tu número de teléfono (con código de país). Ej: +1 305 555 1234",
      ctxPatch: {
        booking: { ...booking, step: "ask_contact" },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  const startISO = (booking as any)?.picked_start || null;
  const endISO = (booking as any)?.picked_end || null;

  if (!startISO || !endISO) {
    return { handled: false, ctxPatch: { booking: { step: "idle" } } };
  }

  await upsertClienteBookingData({
    tenantId,
    canal,
    contacto,
    nombre: name,
    email,
    telefono: phone || null,
  });

  const whenTxt = formatSlotHuman({ startISO, timeZone, idioma });

  return {
    handled: true,
    reply:
      idioma === "en"
        ? `To confirm booking for ${whenTxt}? Reply YES to confirm or NO to cancel.`
        : `Para confirmar: ${whenTxt}. Responde SI para confirmar o NO para cancelar.`,
    ctxPatch: {
      booking: {
        step: "confirm",
        timeZone,
        name,
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
