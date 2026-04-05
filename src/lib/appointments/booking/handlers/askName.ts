// src/lib/appointments/booking/handlers/askName.ts
import type { LangCode } from "../../../i18n/lang";
import { toCanonicalLangOrFallback } from "../../../i18n/lang";

export type AskNameDeps = {
  tenantId: string;
  canal: string;
  contacto: string;
  idioma: LangCode;
  userText: string;

  booking: any;
  timeZone: string;

  wantsToChangeTopic: (s: string) => boolean;
  wantsToCancel: (s: string) => boolean;
  parseFullName: (s: string) => string | null;

  upsertClienteBookingData: (args: {
    tenantId: string;
    canal: string;
    contacto: string;
    nombre?: string | null;
    email?: string | null;
  }) => Promise<any>;
};

export async function handleAskName(deps: AskNameDeps): Promise<{
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
    parseFullName,
    upsertClienteBookingData,
  } = deps;

  const resolvedLang = toCanonicalLangOrFallback(
    booking?.lang ?? idioma,
    "en"
  );

  const hydratedBooking = {
    ...(booking || {}),
    timeZone: booking?.timeZone || timeZone,
    lang: resolvedLang,
  };

  const tz = hydratedBooking.timeZone;
  const effectiveLang: LangCode = resolvedLang;

  if (wantsToChangeTopic(userText)) {
    return {
      handled: false,
      ctxPatch: {
        booking: {
          ...hydratedBooking,
          step: "idle",
          timeZone: tz,
          lang: effectiveLang,
        },
      },
    };
  }

  if (wantsToCancel(userText)) {
    return {
      handled: true,
      reply:
        effectiveLang === "es"
          ? "Claro, no hay problema. Detengo todo por ahora. Cuando estés listo, solo avísame."
          : "Of course, no problem. I’ll stop the process for now. Whenever you’re ready, just tell me.",
      ctxPatch: {
        booking: {
          ...hydratedBooking,
          step: "idle",
          timeZone: tz,
          lang: effectiveLang,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  const name = parseFullName(userText);

  if (!name) {
    return {
      handled: true,
      reply:
        effectiveLang === "es"
          ? "Envíame tu nombre y apellido (ej: Juan Pérez)."
          : "Please send your first and last name (example: John Smith).",
      ctxPatch: {
        booking: {
          ...hydratedBooking,
          step: "ask_name",
          timeZone: tz,
          lang: effectiveLang,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  await upsertClienteBookingData({
    tenantId,
    canal,
    contacto,
    nombre: name,
  });

  const nextNeedsEmail = !String(hydratedBooking?.email || "").trim();

  return {
    handled: true,
    reply: nextNeedsEmail
      ? (
          effectiveLang === "es"
            ? "Gracias. ¿Cuál es tu email? (ej: nombre@email.com)"
            : "Thanks. What’s your email? (example: name@email.com)"
        )
      : (
          effectiveLang === "es"
            ? "Perfecto — ya tengo todo. ¿Confirmo la cita ahora? (sí/no)"
            : "Perfect — I have everything. Do you want me to confirm the appointment now? (yes/no)"
        ),
    ctxPatch: {
      booking: {
        ...hydratedBooking,
        step: nextNeedsEmail ? "ask_email" : "confirm",
        name,
        timeZone: tz,
        lang: effectiveLang,
      },
      booking_last_touch_at: Date.now(),
    },
  };
}