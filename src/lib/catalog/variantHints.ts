function stripDiacritics(s: string) {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

export function userMentionsVariantHint(qRaw: string) {
  const src = stripDiacritics(String(qRaw || "").toLowerCase());
  return (
    /\b(small|medium|large|xl|xxl|xs|x-small)\b/.test(src) ||
    /\b(pequeno|pequeño|pequena|pequeña|mediano|mediana|grande)\b/.test(src) ||
    /\b(\d+\s*(lb|lbs|pounds|kg))\b/.test(src) ||
    /\b(\d+\s*-\s*\d+)\b/.test(src) ||
    /\b(\d+\+)\b/.test(src)
  );
}

export function pickSizeToken(qRaw: string): "small" | "medium" | "large" | "xl" | null {
  const src = stripDiacritics(String(qRaw || "").toLowerCase());

  if (/\b(pequeno|pequeño|pequena|pequeña|small|xs|x-small)\b/.test(src)) return "small";
  if (/\b(mediano|mediana|medium)\b/.test(src)) return "medium";
  if (/\b(grande|large)\b/.test(src)) return "large";
  if (/\b(xl|extra\s*large|extra-large)\b/.test(src)) return "xl";

  return null;
}
