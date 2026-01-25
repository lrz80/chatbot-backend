// src/lib/appointments/booking/handlers/askEmail.ts
export type AskEmailDeps = {
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
  parseEmail: (s: string) => string | null;

  upsertClienteBookingData: (args: {
    tenantId: string;
    canal: string;
    contacto: string;
    nombre?: string | null;
    email?: string | null;
  }) => Promise<any>;
};

export async function handleAskEmail(deps: AskEmailDeps): Promise<{
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
    parseEmail,
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

  const email = parseEmail(userText);
  if (!email) {
    return {
      handled: true,
      reply:
        idioma === "en"
          ? "Please send a valid email (example: name@email.com)."
          : "Envíame un email válido (ej: nombre@email.com).",
      ctxPatch: {
        booking: { ...booking, step: "ask_email", timeZone },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  await upsertClienteBookingData({
    tenantId,
    canal,
    contacto,
    nombre: (booking as any)?.name || null,
    email,
  });

  const hydrated = {
    ...booking,
    email,
    name: (booking as any)?.name || null,
    timeZone,
    // ✅ por seguridad: si tienes picked_* pero no start/end aún
    start_time: (booking as any)?.start_time || (booking as any)?.picked_start || null,
    end_time: (booking as any)?.end_time || (booking as any)?.picked_end || null,
  };

  const hasChosenSlot = !!hydrated.start_time && !!hydrated.end_time;

  // Si ya tenemos slot elegido, volvemos a confirm para reservar (NO pedir fecha otra vez)
  return {
    handled: true,
    reply: hasChosenSlot
      ? (idioma === "en"
          ? "Perfect — I have everything. Please reply YES to confirm or NO to cancel."
          : "Perfecto — ya tengo todo. Responde SI para confirmar o NO para cancelar.")
      : (idioma === "en"
          ? "Great. Now send the date and time in this format: YYYY-MM-DD HH:mm (example: 2026-01-17 15:00)."
          : "Perfecto. Ahora envíame la fecha y hora en este formato: YYYY-MM-DD HH:mm (ej: 2026-01-17 15:00)."),
    ctxPatch: {
      booking: {
        ...hydrated,
        step: hasChosenSlot ? "confirm" : "ask_datetime",
      },
      booking_last_touch_at: Date.now(),
    },
  };
}
