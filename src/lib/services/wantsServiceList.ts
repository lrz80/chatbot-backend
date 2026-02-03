export function wantsServiceList(text: string): boolean {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;

  // ES
  if (/\b(servicios|lista\s+de\s+servicios|que\s+servicios\s+(tienes|ofreces)|catalogo|catálogo|menu|menú|precios|tarifas)\b/i.test(t)) {
    // ojo: "precios" puede ser lista (si no mencionan un servicio específico)
    return true;
  }

  // EN
  if (/\b(services|service\s+list|what\s+services\s+do\s+you\s+(have|offer)|catalog|menu|pricing|price\s+list|rates)\b/i.test(t)) {
    return true;
  }

  return false;
}
