// src/lib/appointments/booking/handlers/askName.ts
export type AskNameDeps = {
  tenantId: string;
  canal: string;
  contacto: string;
  idioma: "es" | "en";
  userText: string;

  booking: any;   // BookingCtx.booking
  timeZone: string;

  // deps
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

    const hydratedBooking = {
    ...booking,
    timeZone,
    lang: booking?.lang || idioma, // ✅ sticky lang
  };

  const effectiveLang: "es" | "en" = (hydratedBooking?.lang as any) || idioma;

  // Escape si cambió de tema -> salimos del flow
  if (wantsToChangeTopic(userText)) {
    return {
      handled: false,
      ctxPatch: { booking: { ...hydratedBooking, step: "idle" } },
    };
  }

  if (wantsToCancel(userText)) {
    return {
      handled: true,
      reply:
        effectiveLang === "en"
          ? "Of course, no problem. I’ll stop the process for now. Whenever you’re ready, just tell me."
          : "Claro, no hay problema. Detengo todo por ahora. Cuando estés listo, solo avísame.",
      ctxPatch: {
        booking: { ...hydratedBooking, step: "idle" },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  const name = parseFullName(userText);
  if (!name) {
    return {
      handled: true,
      reply:
        effectiveLang === "en"
          ? "Please send your first and last name (example: John Smith)."
          : "Envíame tu nombre y apellido (ej: Juan Pérez).",
      ctxPatch: {
        booking: { ...hydratedBooking, step: "ask_name" },
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
      ? (effectiveLang === "en"
          ? "Thanks. What’s your email? (example: name@email.com)"
          : "Gracias. ¿Cuál es tu email? (ej: nombre@email.com)")
      : (effectiveLang === "en"
          ? "Perfect — I have everything. Do you want me to confirm the appointment now? (yes/no)"
          : "Perfecto — ya tengo todo. ¿Confirmo la cita ahora? (sí/no)"),
    ctxPatch: {
      booking: {
        ...hydratedBooking,
        step: nextNeedsEmail ? "ask_email" : "confirm",
        name,
        },
      booking_last_touch_at: Date.now(),
    },
  };
}
