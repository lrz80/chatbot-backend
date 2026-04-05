//src/lib/appointments/booking/text/bookingPrompts.ts
import { toCanonicalLangOrFallback } from "../../../i18n/lang";

export function buildAskAllMessage(idioma?: string | null, purpose?: string | null) {
  const lang = toCanonicalLangOrFallback(idioma, "en");

  if (lang === "es") {
    return (
      `Perfecto, te ayudo con eso.\n` +
      `Hazme un favor: mándame todo junto en un solo mensaje.\n` +
      `Tu nombre completo, tu email, y la fecha y hora que te gustaría.\n` +
      `Algo así como: Juan Pérez, juan@email.com, 2026-01-21 14:00`
    );
  }

  return (
    `Perfect, I can help you with that.\n` +
    `Do me a favor — send me everything in one single message:\n` +
    `your full name, your email, and the date and time you want.\n` +
    `Something like: John Smith, john@email.com, 2026-01-21 14:00`
  );
}