// src/lib/appointments/booking/handlers/askPurpose.ts

export type AskPurposeDeps = {
  idioma: "es" | "en";
  userText: string;

  booking: any;
  timeZone: string;
  tenantId: string;
  canal: string;

  wantsToChangeTopic: (s: string) => boolean;
  wantsToCancel: (s: string) => boolean;
  detectPurpose: (s: string) => string | null;
};

export async function handleAskPurpose(deps: AskPurposeDeps): Promise<{
  handled: boolean;
  reply?: string;
  ctxPatch?: any;
}> {
  const {
    idioma,
    userText,
    booking,
    timeZone,
    wantsToChangeTopic,
    wantsToCancel,
    detectPurpose,
  } = deps;

  const effectiveLang: "es" | "en" = (booking?.lang as any) || idioma;

  // Escape: usuario cambió de tema
  if (wantsToChangeTopic(userText)) {
    return {
      handled: false,
      ctxPatch: { booking: { ...(booking || {}), step: "idle" } },
    };
  }

  // Cancelar proceso
  if (wantsToCancel(userText)) {
    return {
      handled: true,
      reply:
        effectiveLang === "en"
          ? "Of course, no problem. I’ll stop the process for now. Whenever you’re ready, just tell me."
          : "Claro, no hay problema. Detengo todo por ahora. Cuando estés listo, solo avísame.",
      ctxPatch: {
        booking: { ...(booking || {}), step: "idle" },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // Intentar identificar propósito
  const purpose = detectPurpose(userText);

  if (!purpose) {
    return {
      handled: true,
      reply:
        effectiveLang === "en"
          ? "Got it. Is it an appointment, class, consultation, or a call?"
          : "Entiendo. ¿Es una cita, clase, consulta o llamada?",
      ctxPatch: {
        booking: { ...(booking || {}), step: "ask_purpose", timeZone, lang: effectiveLang },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // Avanza a ask_daypart
  return {
    handled: true,
    reply:
      effectiveLang === "en"
        ? "Sure, I can help you schedule it. Does morning or afternoon work better for you?"
        : "Claro, puedo ayudarte a agendar. ¿Te funciona más en la mañana o en la tarde?",
    ctxPatch: {
      booking: {
        ...(booking || {}),
        step: "ask_daypart",
        timeZone,
        purpose,
        lang: effectiveLang,
      },
      booking_last_touch_at: Date.now(),
    },
  };
}
