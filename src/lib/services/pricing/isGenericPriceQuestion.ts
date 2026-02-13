export function isGenericPriceQuestion(text: string): boolean {
  const t = String(text || "").toLowerCase().trim();

  const genericMatch =
    /\b(precios?|tarifas?|costos?)\b/.test(t) ||
    /\b(cu[aá]les\s+son\s+los\s+precios?)\b/.test(t) ||
    /\b(what\s+are\s+the\s+prices?|prices?\s*\?)\b/.test(t) ||
    /\b(pricing|price\s+list|price\s+range)\b/.test(t);

  if (!genericMatch) return false;

  // 🔥 Detectar si hay palabras adicionales relevantes (ancla específica)
  const tokens = t
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const STOPWORDS = new Set([
    "precio", "precios", "tarifa", "tarifas", "costo", "costos",
    "cuanto", "cuanta", "cuestan", "vale", "valen",
    "what", "are", "the", "price", "prices", "pricing",
    "plan", "planes", "membresia", "membresias",
    "monthly", "membership", "de", "los", "las", "del"
  ]);

  // Si existe al menos un token que NO sea stopword → no es genérica
  const hasSpecificWord = tokens.some(t => !STOPWORDS.has(t) && t.length >= 3);

  return !hasSpecificWord;
}
