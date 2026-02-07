// src/lib/services/wantsServiceList.ts

export function wantsServiceList(text: string) {
  const t = String(text || "").toLowerCase().trim();

  // Solo si pide explícitamente lista/catálogo/menú
  return /\b(lista|men[uú]|menu|cat[aá]logo|catalog|list\s+of\s+services|show\s+me\s+the\s+services)\b/.test(t);
}
