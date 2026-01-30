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

  const hydratedBooking = {
    ...(booking || {}),
    timeZone: (booking?.timeZone as any) || timeZone, // ✅ sticky tz
    lang: (booking?.lang as any) || idioma,           // ✅ sticky lang
  };

  const effectiveLang: "es" | "en" = hydratedBooking.lang;
  const tz = hydratedBooking.timeZone;

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

  const email = parseEmail(userText);
  if (!email) {
    return {
      handled: true,
      reply:
        effectiveLang === "en"
          ? "Please send a valid email (example: name@email.com)."
          : "Envíame un email válido (ej: nombre@email.com).",
      ctxPatch: {
        booking: { ...hydratedBooking, step: "ask_email", timeZone: tz },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  await upsertClienteBookingData({
    tenantId,
    canal,
    contacto,
    nombre: (hydratedBooking as any)?.name || null,
    email,
  });

  const hydrated = {
    ...hydratedBooking,
    email,
    name: (hydratedBooking as any)?.name || null,
    timeZone: tz,
    start_time: (hydratedBooking as any)?.start_time || (hydratedBooking as any)?.picked_start || null,
    end_time: (hydratedBooking as any)?.end_time || (hydratedBooking as any)?.picked_end || null,
  };

  const hasChosenSlot = !!hydrated.start_time && !!hydrated.end_time;

  // Si ya tenemos slot elegido, volvemos a confirm para reservar (NO pedir fecha otra vez)
  return {
    handled: true,
    reply: hasChosenSlot
      ? (effectiveLang === "en"
          ? "Perfect — I have everything. Please reply YES to confirm or NO to cancel."
          : "Perfecto — ya tengo todo. Responde SI para confirmar o NO para cancelar.")
      : (effectiveLang === "en"
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
