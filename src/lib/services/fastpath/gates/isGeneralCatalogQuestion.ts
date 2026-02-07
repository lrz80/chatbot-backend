// backend/src/lib/services/fastpath/gates/isGeneralCatalogQuestion.ts

export function isGeneralCatalogQuestion(text: string) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;

  // 0) Si piden dato concreto → NO es general (esto SÍ puede ir a DB)
  const asksSpecific =
    /\b(precio|precios|cu[aá]nto|cuesta|vale|tarifa)\b/.test(t) ||
    /\b(price|prices|how\s*much|cost|rate|fee|pricing)\b/.test(t) ||
    /\b(que\s+incluye|incluye|incluido|includes|what\s+(is\s+)?included)\b/.test(t) ||
    /\b(duraci[oó]n|duration|cu[aá]nto\s+dura|how\s+long)\b/.test(t) ||
    /\b(link|enlace|url|booking\s+link|reservation\s+link)\b/.test(t);

  if (asksSpecific) return false;

  // 1) "Más info" / "detalles" / "explícame" → GENERAL (NO DB)
  const asksMoreInfo =
    /\b(m[aá]s\s*info(rmaci[oó]n)?|quiero\s+m[aá]s\s+info|dame\s+m[aá]s\s+info|m[aá]s\s+detalles|detalles|informaci[oó]n\s+por\s+favor|me\s+puedes\s+explicar|en\s+qu[eé]\s+consiste)\b/.test(
      t
    ) ||
    /\b(more\s+info(rmation)?|more\s+details|tell\s+me\s+more|information\s+please|can\s+you\s+explain)\b/.test(
      t
    );

  if (asksMoreInfo) return true;

  // 2) Catálogo general / opciones / "qué ofrecen" → GENERAL (NO DB)
  const asksCatalog =
    /\b(que\s+servicios\s+ofrecen|servicios\s+ofrecen|que\s+ofrecen|que\s+tienen|que\s+hacen|que\s+hay|que\s+opciones\s+tienen)\b/.test(
      t
    ) ||
    /\b(what\s+do\s+you\s+offer|what\s+services\s+do\s+you\s+have|what\s+do\s+you\s+have|what\s+options\s+do\s+you\s+have)\b/.test(
      t
    ) ||
    /\b(cat[aá]logo|catalog|lista\s+de\s+servicios|list\s+of\s+services|men[uú]|menu)\b/.test(t);

  // 3) Recomendación / indecisión → GENERAL (NO DB)
  const asksRecommendation =
    /\b(recom(i|í)end(a|as|ame|ame\s+algo)?|que\s+me\s+recomiendas|que\s+me\s+sugieres|sugerencia|sugi[eé]reme)\b/.test(
      t
    ) ||
    /\b(recommend|suggest|what\s+do\s+you\s+recommend|what\s+do\s+you\s+suggest)\b/.test(t) ||
    /\b(primera\s+vez|first\s+time|no\s+s[eé]\s+cu[aá]l|not\s+sure\s+which|i\s+don'?t\s+know\s+which)\b/.test(
      t
    );

  // 4) Señales de “generalidad” (pero suaves):
  //    Si solo dicen "servicios" o "services" sin más, suele ser general.
  //    Si el texto tiene bastante contenido (>= 3 palabras) y NO está preguntando por catálogo explícito,
  //    mejor NO marcarlo como general (deja que el pipeline normal decida).
  const wordCount = t.split(/\s+/).filter(Boolean).length;
  const softGeneral =
    /\b(servicios|services|lista|menu|cat[aá]logo|catalog)\b/.test(t) && wordCount <= 3;

  return asksCatalog || asksRecommendation || softGeneral;
}
