// backend/src/lib/services/fastpath/gates/isGeneralCatalogQuestion.ts

export function isGeneralCatalogQuestion(text: string) {
  const t = String(text || "").toLowerCase().trim();

  // 1) Si piden dato concreto → NO es general (eso sí va a DB)
  const asksSpecific =
    /\b(precio|precios|cu[aá]nto|cuesta|vale|tarifa|cost|price|pricing|rate|fee)\b/.test(t) ||
    /\b(que\s+incluye|incluye|includes|what\s+is\s+included)\b/.test(t) ||
    /\b(duraci[oó]n|duration|cu[aá]nto\s+dura|how\s+long)\b/.test(t) ||
    /\b(link|enlace|url|booking\s+link|reservation\s+link)\b/.test(t);

  if (asksSpecific) return false;

  // 2) Si están pidiendo "catálogo general" / "recomendación" → ES general (NO DB)
  const asksGeneralCatalog =
    /\b(que\s+servicios\s+ofrecen|servicios\s+ofrecen|que\s+tienen|que\s+hacen|que\s+ofrecen)\b/.test(t) ||
    /\b(servicios|services|cat[aá]logo|catalog|men[uú]|menu|lista)\b/.test(t) ||
    /\b(recom(i|í)end(a|as|ame)?|recommend|suggest|sugerencia|que\s+me\s+recomiendas)\b/.test(t) ||
    /\b(primera\s+vez|first\s+time|no\s+s[eé]\s+cu[aá]l)\b/.test(t);

  return asksGeneralCatalog;
}
