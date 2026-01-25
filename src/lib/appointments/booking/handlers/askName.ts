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

  // Escape si cambió de tema -> salimos del flow
  if (wantsToChangeTopic(userText)) {
    return {
      handled: false,
      ctxPatch: { booking: { step: "idle" } },
    };
  }

  if (wantsToCancel(userText)) {
    return {
      handled: true,
      reply:
        idioma === "en"
          ? "Of course, no problem. I’ll stop the process for now. Whenever you’re ready, just tell me."
          : "Claro, no hay problema. Detengo todo por ahora. Cuando estés listo, solo avísame.",
      ctxPatch: {
        booking: { step: "idle" },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  const name = parseFullName(userText);
  if (!name) {
    return {
      handled: true,
      reply:
        idioma === "en"
          ? "Please send your first and last name (example: John Smith)."
          : "Envíame tu nombre y apellido (ej: Juan Pérez).",
      ctxPatch: {
        booking: { ...booking, step: "ask_name", timeZone },
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

  const nextNeedsEmail = !booking?.email;

  return {
    handled: true,
    reply: nextNeedsEmail
      ? (idioma === "en"
          ? "Thanks. What’s your email? (example: name@email.com)"
          : "Gracias. ¿Cuál es tu email? (ej: nombre@email.com)")
      : (idioma === "en"
          ? "Perfect — I have everything. Do you want me to confirm the appointment now? (yes/no)"
          : "Perfecto — ya tengo todo. ¿Confirmo la cita ahora? (sí/no)"),
    ctxPatch: {
      booking: {
        ...booking,                 // ✅ NO pierdas picked_start/picked_end, date_only, etc.
        step: nextNeedsEmail ? "ask_email" : "confirm",
        timeZone,
        name,                       // ✅ actualiza nombre
      },
      booking_last_touch_at: Date.now(),
    },
  };
}
