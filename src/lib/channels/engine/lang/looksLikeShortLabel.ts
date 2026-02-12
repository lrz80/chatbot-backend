// backend/src/lib/channels/engine/lang/looksLikeShortLabel.ts

export function tokenCount(text: string): number {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

/**
 * Heurística genérica (NO industria) para detectar inputs cortos tipo "label"
 * (p.ej. nombre de servicio / categoría / opción) que NO deberían cambiar el idioma del hilo.
 *
 * Ejemplos típicos: "Indoor cycling", "Deluxe Groom", "Small", "Corte de uñas"
 */
export function looksLikeShortLabel(text: string): boolean {
  const t = String(text || "").trim();
  if (!t) return false;

  const n = tokenCount(t);
  if (n > 4) return false; // 1-4 palabras = suele ser "label"

  // Si trae signos de oración, suele ser frase real
  if (/[.!?¿¡]/.test(t)) return false;

  // Verbos / estructuras de pregunta ES/EN (señales generales)
  const hasVerbOrQuestion =
    // ES
    /\b(quiero|necesito|busco|puedo|podr[ií]a|me\s+gustar[ií]a|tengo|tienes|hay|est[aá]n|ofrecen|cu[aá]nto|cu[aá]les|informaci[oó]n|detalles)\b/i.test(t) ||
    // EN
    /\b(i|we)\s+(want|need|am|have)\b/i.test(t) ||
    /\b(can|could|would|do\s+you|are\s+you|is\s+there|how\s+much|what|details|info)\b/i.test(t);

  return !hasVerbOrQuestion;
}
