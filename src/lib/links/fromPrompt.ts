// backend/src/lib/links/fromPrompt.ts
// Usa tu extractor existente si ya tienes extractAllLinksFromPrompt(prompt, max)
const URL_REGEX =
  /\bhttps?:\/\/[^\s)>"']+|(?:wa\.me|t\.me|instagram\.com|facebook\.com|m\.facebook\.com|fb\.com|linktr\.ee|forms\.gle|bit\.ly|tinyurl\.com)\/[^\s)>"']+/gi;

export type PromptLinks = {
  all: string[];
  bestMemberships?: string; // planes / membresías / precios
  bestClasses?: string;     // horario / reservas / calendario
  bestContact?: string;     // WhatsApp / contacto
};

const MEMBERSHIPS_HINTS = [
  'membership', 'memberships', 'membresía', 'membresías',
  'precio', 'precios', 'planes', 'plan', 'suscripción', 'subscription',
  'pricing', 'checkout', 'buy', 'purchase'
];

const CLASSES_HINTS = [
  'horario', 'calendario', 'clases', 'reservas', 'reserva',
  'agenda', 'schedule', 'booking', 'book', 'calendar', 'classes'
];

const CONTACT_HINTS = [
  'wa.me', 'whatsapp', 'contacto', 'tel', 'telefono', 'phone', 't.me'
];

function score(url: string, hints: string[]): number {
  const u = url.toLowerCase();
  return hints.reduce((acc, h) => acc + (u.includes(h) ? 1 : 0), 0);
}

export function extractLinksFromPrompt(promptText: string, max: number = 20): PromptLinks {
  const all = (promptText || '').match(URL_REGEX)?.slice(0, max) || [];

  let bestMemberships: string | undefined;
  let bestClasses: string | undefined;
  let bestContact: string | undefined;

  let bestMScore = -1, bestCScore = -1, bestTScore = -1;

  for (const url of all) {
    const m = score(url, MEMBERSHIPS_HINTS);
    const c = score(url, CLASSES_HINTS);
    const t = score(url, CONTACT_HINTS);

    if (m > bestMScore) { bestMScore = m; bestMemberships = url; }
    if (c > bestCScore) { bestCScore = c; bestClasses = url; }
    if (t > bestTScore) { bestTScore = t; bestContact = url; }
  }

  return { all, bestMemberships, bestClasses, bestContact };
}
