import { toCanonicalLangOrFallback } from "../../../i18n/lang";
import { humanizeBookingReply } from "../humanizer";

type BookingPurpose =
  | "appointment"
  | "class"
  | "consultation"
  | "call"
  | "visit"
  | "demo";

export type AskPurposeDeps = {
  idioma?: string | null;
  userText: string;

  booking: any;
  timeZone: string;
  tenantId: string;
  canal: string;

  wantsToChangeTopic: (s: string) => boolean;
  wantsToCancel: (s: string) => boolean;
  detectPurpose: (s: string) => BookingPurpose | null;
};

const PURPOSE_LABELS: Record<BookingPurpose, { en: string; es: string }> = {
  appointment: {
    en: "an appointment",
    es: "una cita",
  },
  class: {
    en: "a class",
    es: "una clase",
  },
  consultation: {
    en: "a consultation",
    es: "una consulta",
  },
  call: {
    en: "a call",
    es: "una llamada",
  },
  visit: {
    en: "a visit",
    es: "una visita",
  },
  demo: {
    en: "a demo",
    es: "una demostración",
  },
};

function getPurposeLabel(
  purpose: BookingPurpose,
  lang: string
): string {
  const labels = PURPOSE_LABELS[purpose];
  return lang === "es" ? labels.es : labels.en;
}

export async function handleAskPurpose(
  deps: AskPurposeDeps
): Promise<{
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

  const resolvedLang = toCanonicalLangOrFallback(
    booking?.lang ?? idioma,
    "en"
  );

  const hydratedBooking = {
    ...(booking || {}),
    timeZone: booking?.timeZone || timeZone,
    lang: resolvedLang,
  };

  const effectiveLang = resolvedLang;
  const tz = hydratedBooking.timeZone;

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
    const canonicalText =
      effectiveLang === "es"
        ? "Perfecto — pauso el agendamiento por ahora. Cuando estés listo, me dices."
        : "No problem — I’ll pause scheduling for now. Whenever you’re ready, just tell me.";

    const reply = await humanizeBookingReply({
      idioma: effectiveLang,
      intent: "cancel_booking",
      askedText: userText,
      canonicalText,
      locked: [],
    });

    return {
      handled: true,
      reply,
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

  const purpose = detectPurpose(userText);

  if (!purpose) {
    const canonicalText =
      effectiveLang === "es"
        ? "Entiendo — ¿qué te gustaría agendar? (clase, cita, consulta, llamada, visita o demostración)"
        : "Got it — what are you trying to book? (class, appointment, consultation, call, visit, or demo)";

    const reply = await humanizeBookingReply({
      idioma: effectiveLang,
      intent: "ask_purpose_clarify",
      askedText: userText,
      canonicalText,
      locked: [],
    });

    return {
      handled: true,
      reply,
      ctxPatch: {
        booking: {
          ...hydratedBooking,
          step: "ask_purpose",
          timeZone: tz,
          lang: effectiveLang,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  const purposeLabel = getPurposeLabel(purpose, effectiveLang);

  const canonicalText =
    effectiveLang === "es"
      ? `Perfecto — para ${purposeLabel}, ¿te funciona mejor en la mañana o en la tarde?`
      : `Perfect — for ${purposeLabel}, do mornings or afternoons work better?`;

  const reply = await humanizeBookingReply({
    idioma: effectiveLang,
    intent: "ask_daypart",
    askedText: userText,
    canonicalText,
    locked: [purposeLabel],
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