// src/lib/services/wantsServiceList.ts

export function wantsServiceList(text: string): boolean {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;

  // ✅ Si está preguntando precios, NO es lista de servicios
  if (
    /\b(precio|precios|cu[aá]nto cuesta|cu[aá]nto valen|tarifa|tarifas|cost|price|pricing|how much|rates|rate)\b/i.test(
      t
    )
  ) {
    return false;
  }

  // ✅ IMPORTANTE: si pregunta por "a domicilio / pickup / delivery"
  // NO es lista de servicios; es una pregunta de logística
  if (/\b(a\s+domicilio|domicilio|home\s+service|mobile\s+service|delivery|pickup)\b/i.test(t)) {
    return false;
  }

  // ES: catálogo/menú/lista de servicios
  if (
    /\b(servicios|lista\s+de\s+servicios|qu[eé]\s+servicios\s+(tienes|ofreces)|qu[eé]\s+ofrecen|cat[aá]logo|menu|men[uú])\b/i.test(
      t
    )
  ) {
    return true;
  }

  // EN: services/menu/catalog
  if (
    /\b(services|service\s+list|what\s+services\s+do\s+you\s+(have|offer)|what\s+do\s+you\s+offer|catalog|menu)\b/i.test(
      t
    )
  ) {
    return true;
  }

  return false;
}
