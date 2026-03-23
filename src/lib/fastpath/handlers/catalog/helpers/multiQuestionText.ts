// src/lib/fastpath/handlers/catalog/helpers/multiQuestionText.ts

export function localTokens(
  normalizeText: (input: string) => string,
  raw: string
): string[] {
  return normalizeText(String(raw || ""))
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export const MULTI_QUESTION_NOISE_TOKENS = new Set([
  "de", "del", "la", "el", "los", "las", "un", "una", "unos", "unas",
  "para", "por", "en", "y", "o", "u", "a", "que", "q", "este", "esta",
  "ese", "esa", "esto", "eso", "le", "lo", "al", "como", "con", "sin",
  "sobre", "mi", "tu", "su", "me", "te", "se",
  "the", "a", "an", "and", "or", "to", "for", "in", "of", "what", "does",
  "do", "is", "are", "with", "without", "about", "my", "your", "their",
  "me", "you", "it",
  "precio", "precios", "cuanto", "cuanta", "cuánto", "cuánta",
  "cuesta", "cuestan", "vale", "valen", "costo", "costos",
  "mensual", "mensuales", "mes", "meses", "mensualidad", "desde",
  "price", "prices", "pricing", "cost", "costs", "how", "much",
  "monthly", "month", "months", "from", "starting", "starts",
  "what", "which", "quiero", "quieres", "want", "looking"
]);