export type ServiceInfoNeed = "price" | "duration" | "includes" | "any";

const PRICE_RE = /\b(cu[aá]nto\s+cuesta|precio(s)?|vale|costo|cost|price|how\s+much)\b/i;
const DURATION_RE = /\b(cu[aá]nto\s+dura|duraci[oó]n|minutos|minutes|duration|how\s+long)\b/i;
const INCLUDES_RE = /\b(qu[eé]\s+incluye|incluye|incluido|includes|what('s)?\s+included)\b/i;
const INFO_RE = /\b(info|informaci[oó]n|details|detail)\b/i;

// Señal universal de que el usuario está refiriéndose a "algo" (servicio/ítem)
// sin hardcode por industria.
function hasObjectAnchor(t: string): boolean {
  // "precio de X", "price for X", "cost of X"
  if (/\b(de(l)?|para|por|for|of)\b/i.test(t)) {
    // Tiene al menos 1 token "contenido" después del conector
    // (evita "precio de", "price for" sin nada)
    const parts = t.split(/\b(de(l)?|para|por|for|of)\b/i);
    const tail = (parts[parts.length - 1] || "").trim();
    if (tail.length >= 2) return true;
  }

  // Si usan comillas: "Full grooming", 'Plan X'
  if (/["'“”‘’].{2,}["'“”‘’]/.test(t)) return true;

  // Si hay 3+ palabras y no es puro filler, suele haber objeto
  const tokens = t
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  // Quita stopwords universales (no por industria)
  const stop = new Set([
    "el","la","los","las","un","una","unos","unas",
    "de","del","para","por","en","con","a",
    "the","a","an","to","for","of","in","on","with",
    "me","my","mi","mis","your","tu","tus","please","pls"
  ]);

  // "class / clase" suelen indicar objeto aunque no haya "for/of/de"
  if (/\b(class|clase)\b/i.test(t)) {
    const cleaned = t.replace(/\b(class|clase)\b/gi, "").trim();
    if (cleaned.length >= 3) return true;
  }

  const contentTokens = tokens.filter(x => !stop.has(x));
  return contentTokens.length >= 3; // "precio del corte fade" -> ok, "cuales son los precios" -> no
}

function isGenericPriceQuestion(t: string): boolean {
  if (!PRICE_RE.test(t)) return false;

  // Si NO hay ancla/objeto, lo consideramos genérico
  if (!hasObjectAnchor(t)) return true;

  return false;
}

export function wantsServiceInfo(text: string): ServiceInfoNeed | null {
  const t = String(text || "").trim().toLowerCase();

  // ✅ Evita que "¿Cuáles son los precios?" dispare service_info (multitenant-safe)
  if (isGenericPriceQuestion(t)) {
    return null;
  }

  if (PRICE_RE.test(t)) return "price";
  if (DURATION_RE.test(t)) return "duration";
  if (INCLUDES_RE.test(t)) return "includes";
  if (INFO_RE.test(t)) return "any";

  return null;
}
