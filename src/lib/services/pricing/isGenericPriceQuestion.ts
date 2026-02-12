// backend/src/lib/services/pricing/isGenericPriceQuestion.ts

export function isGenericPriceQuestion(text: string): boolean {
  const t = String(text || "").toLowerCase().trim();

  // Preguntas genéricas típicas (ES/EN) sin depender de industria
  // Ej: "cuales son los precios", "precios?", "pricing", "price list"
  return (
    /\b(precios?|tarifas?|costos?)\b/.test(t) ||
    /\b(cu[aá]les\s+son\s+los\s+precios?)\b/.test(t) ||
    /\b(what\s+are\s+the\s+prices?|prices?\s*\?)\b/.test(t) ||
    /\b(pricing|price\s+list|price\s+range)\b/.test(t)
  );
}
