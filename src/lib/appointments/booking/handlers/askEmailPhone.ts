// src/lib/appointments/booking/handlers/askEmailPhone.ts
import type { LangCode } from "../../../i18n/lang";
import { toCanonicalLangOrFallback } from "../../../i18n/lang";
import { parseEmail, parsePhone } from "../text";
import { formatSlotHuman } from "../time";

export type AskEmailPhoneDeps = {
  tenantId: string;
  canal: string;
  idioma: LangCode;
  userText: string;

  booking: any;
  timeZone: string;

  wantsToChangeTopic: (s: string) => boolean;
  wantsToCancel: (s: string) => boolean;

  requirePhone: boolean;

  upsertClienteBookingData: (args: {
    tenantId: string;
    canal: string;
    nombre: string;
    email: string;
    telefono?: string | null;
  }) => Promise<any>;
};

export async function handleAskEmailPhone(
  deps: AskEmailPhoneDeps
): Promise<{
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

  const resolvedLang = toCanonicalLangOrFallback(
    booking?.lang || idioma,
    "en"
  );

  const hydratedBooking = {
    ...booking,
    timeZone: booking?.timeZone || timeZone,
    lang: resolvedLang,
  };

  const effectiveLang: LangCode = hydratedBooking.lang;
  const tz = hydratedBooking.timeZone;

  if (wantsToChangeTopic(userText)) {
    return {
      handled: false,
      ctxPatch: {
        booking: { ...hydratedBooking, step: "idle" },
      },
    };
  }

  if (wantsToCancel(userText)) {
    return {
      handled: true,
      reply:
        effectiveLang === "es"
          ? "No hay problema, cuando necesites agendar estaré aquí para ayudarte."
          : "No worries, whenever you’re ready to schedule, I’ll be here to help.",
      ctxPatch: {
        booking: { ...hydratedBooking, step: "idle" },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  const email = parseEmail(userText);
  const parsedPhone = parsePhone(userText);

  const waPhone =
    canal === "whatsapp" ? String(booking?.phone || "").trim() : "";

  const phone = parsedPhone || (waPhone ? waPhone : null);

  if (!email) {
    return {
      handled: true,
      reply:
        effectiveLang === "es"
          ? (
              requirePhone
                ? "Por favor envíame tu email y tu teléfono en un solo mensaje (ej: nombre@email.com, +1 305 555 1234)."
                : "Por favor envíame tu email en un solo mensaje (ej: nombre@email.com)."
            )
          : (
              requirePhone
                ? "Please send your email and phone in one message (example: name@email.com, +1 305 555 1234)."
                : "Please send your email in one message (example: name@email.com)."
            ),
      ctxPatch: {
        booking: {
          ...hydratedBooking,
          step: "ask_email_phone",
          timeZone: tz,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  if (requirePhone && !phone) {
    return {
      handled: true,
      reply:
        effectiveLang === "es"
          ? "Ya tengo tu email. Ahora envíame tu teléfono con código de país (ej: +1 305 555 1234)."
          : "I got your email. Now send your phone number with country code (example: +1 305 555 1234).",
      ctxPatch: {
        booking: {
          ...hydratedBooking,
          step: "ask_email_phone",
          timeZone: tz,
          email,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  const name = hydratedBooking?.name || null;
  if (!name) {
    return {
      handled: true,
      reply:
        effectiveLang === "es"
          ? "Antes de confirmar, ¿cuál es tu nombre y apellido? (ej: Juan Pérez)"
          : "Before confirming, what is your first and last name? (example: John Smith)",
      ctxPatch: {
        booking: { ...hydratedBooking, step: "ask_name" },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  const startISO = hydratedBooking?.picked_start || hydratedBooking?.start_time || null;
  const endISO = hydratedBooking?.picked_end || hydratedBooking?.end_time || null;

  if (!startISO || !endISO) {
    return {
      handled: false,
      ctxPatch: {
        booking: { ...hydratedBooking, step: "idle" },
      },
    };
  }

  await upsertClienteBookingData({
    tenantId,
    canal,
    nombre: name,
    email,
    telefono: phone,
  });

  const whenTxt = formatSlotHuman({
    startISO,
    timeZone: tz,
    idioma: effectiveLang,
  });

  return {
    handled: true,
    reply:
      effectiveLang === "es"
        ? `Perfecto. Confirmo tu cita para ${whenTxt}. Responde SI para confirmar o NO para cancelar.`
        : `Perfect. Confirm booking for ${whenTxt}? Reply YES to confirm or NO to cancel.`,
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