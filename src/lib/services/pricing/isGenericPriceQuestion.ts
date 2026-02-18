export function isGenericPriceQuestion(text: string): boolean {
  const t = String(text || "").toLowerCase().trim();

  // ===============================
  // ✅ GUARD: preguntas de planes/membresías NO son "precio genérico"
  // (evita que "q planes tienes" caiga en resumen genérico)
  // ===============================
  const asksPlans =
    /\b(planes?|plan)\b/.test(t) ||
    /\b(membres[ií]as?|membresia)\b/.test(t) ||
    /\b(memberships?|membership)\b/.test(t) ||
    /\b(monthly)\b/.test(t);

  if (asksPlans) return false;

  // ✅ si es la pregunta genérica exacta, no la discutas
  if (/^\s*(cu[aá]les\s+son\s+los\s+precios?)\s*\??\s*$/.test(t)) return true;
  if (/^\s*(what\s+are\s+the\s+prices?)\s*\??\s*$/.test(t)) return true;

  const genericMatch =
    /\b(precios?|tarifas?|costos?)\b/.test(t) ||
    /\b(cu[aá]les\s+son\s+los\s+precios?)\b/.test(t) ||
    /\b(what\s+are\s+the\s+prices?|prices?\s*\?)\b/.test(t) ||
    /\b(pricing|price\s+list|price\s+range)\b/.test(t);

  if (!genericMatch) return false;

  const tokens = t
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const STOPWORDS = new Set([
    // ES
    "precio","precios","tarifa","tarifas","costo","costos",
    "cuales","cual","que","son","es","ser","de","del","la","las","el","los","un","una","unos","unas",
    "me","te","se","mi","tu","su","por","para","en","al","a",
    "cuanto","cuanta","cuestan","cuesta","vale","valen",
    // EN
    "what","are","the","is","do","you","have",
    "price","prices","pricing","list","range",
    // ❌ REMOVIDO: "plan","planes","membresia","membresias","monthly","membership"
  ]);

  // Si existe al menos un token que NO sea stopword → no es genérica
  const hasSpecificWord = tokens.some(x => !STOPWORDS.has(x) && x.length >= 3);

  return !hasSpecificWord;
}
