/**
 * Pregunta de precio "genérica" = pregunta de precios en general,
 * NO sobre un plan/servicio concreto por nombre.
 *
 * Ejemplos → TRUE (genéricas):
 *  - "¿Qué precio tienen las clases funcionales?"
 *  - "¿Cuáles son sus precios?"
 *  - "How much do your classes cost?"
 *
 * Ejemplos → FALSE (específicas):
 *  - "precio plan gold"
 *  - "precio del plan bronze autopay"
 *  - "how much is the VIP membership?"
 */
export function isGenericPriceQuestion(text: string): boolean {
  const raw = String(text || "");
  if (!raw.trim()) return false;

  const t = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  // 1) Tiene que ser claramente una pregunta de precio
  const hasPriceWord = /\b(precio|precios|tarifa|tarifas|costo|costos|cost|price|prices|pricing|how much|cuanto cuesta|cuanto vale|cuanto cobran|cuanto cobran|cuanto sale)\b/.test(
    t
  );
  if (!hasPriceWord) return false;

  // 2) ¿Está hablando explícitamente de "planes / membresías / paquetes"?
  const mentionsPlanUnit = /\b(plan|planes|membresia|membresias|membership|memberships|paquete|paquetes|package|packages|bundle|bundles|pack|packs|monthly)\b/.test(
    t
  );

  // 3) ¿Menciona un NOMBRE típico de plan? (genérico, no de un negocio)
  const mentionsNamedPlan = /\b(gold|bronze|silver|platinum|vip|basic|standard|premium|plus|pro)\b/.test(
    t
  );

  // Si pregunta por "plan gold", "membresía platinum", etc.
  // → NO es genérica, es de un plan concreto.
  if (mentionsPlanUnit && mentionsNamedPlan) {
    return false;
  }

  // En cualquier otro caso, tratamos la pregunta como "precio genérico"
  // (incluye cosas como "qué precio tienen las clases funcionales?")
  return true;
}