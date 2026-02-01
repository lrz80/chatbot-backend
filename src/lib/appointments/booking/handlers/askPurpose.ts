// src/lib/appointments/booking/handlers/askPurpose.ts
import { humanizeBookingReply } from "../humanizer";

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

  const hydratedBooking = {
    ...(booking || {}),
    timeZone: (booking?.timeZone as any) || timeZone, // ✅ sticky tz
    lang: (booking?.lang as any) || idioma,           // ✅ sticky lang
  };

  const effectiveLang: "es" | "en" = hydratedBooking.lang;
  const tz = hydratedBooking.timeZone;

  // Escape: usuario cambió de tema
  if (wantsToChangeTopic(userText)) {
    return {
      handled: false,
      ctxPatch: { booking: { ...hydratedBooking, step: "idle", timeZone: tz, lang: effectiveLang } },
    };
  }

  // Cancelar proceso
  if (wantsToCancel(userText)) {
    const reply = await humanizeBookingReply({
      idioma: effectiveLang,
      intent: "cancel_booking",
      askedText: userText,
    });

    return {
      handled: true,
      reply,
      ctxPatch: {
        booking: { ...hydratedBooking, step: "idle", timeZone: tz, lang: effectiveLang },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // Intentar identificar propósito
  const purpose = detectPurpose(userText);

  if (!purpose) {
    const reply = await humanizeBookingReply({
      idioma: effectiveLang,
      intent: "ask_purpose_clarify",
      askedText: userText,
    });

    return {
      handled: true,
      reply,
      ctxPatch: {
        booking: { ...hydratedBooking, step: "ask_purpose", timeZone: tz, lang: effectiveLang },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // Avanza a ask_daypart
  const reply = await humanizeBookingReply({
    idioma: effectiveLang,
    intent: "ask_daypart",
    askedText: userText,
    purpose,
  });

  return {
    handled: true,
    reply,
    ctxPatch: {
      booking: {
        ...hydratedBooking,
        step: "ask_daypart",
        timeZone: tz,
        purpose,
        lang: effectiveLang,
      },
      booking_last_touch_at: Date.now(),
    },
  };
}
