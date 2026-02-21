// WhatsApp permite ~4096 chars, pero 1200 es más seguro.
// El bot viejo usaba 1000, podemos dejarlo igual.
const DEFAULT_LIMIT = 1000;

/**
 * Divide un mensaje largo en partes sin cortar palabras,
 * respetando saltos de línea cuando sea posible.
 */
export function splitMessage(
  text: string,
  limit: number = DEFAULT_LIMIT
): string[] {
  if (!text || text.length <= limit) return [text];

  const parts: string[] = [];
  let remaining = text.trim();

  while (remaining.length > limit) {
    // Intentar cortar en salto de línea antes del límite
    let cut = remaining.lastIndexOf("\n", limit);

    // Si no hay salto de línea, cortar en espacio
    if (cut === -1) {
      cut = remaining.lastIndexOf(" ", limit);
    }

    // Si tampoco hay espacio, cortar exactamente en el límite
    if (cut === -1) cut = limit;

    const chunk = remaining.slice(0, cut).trim();
    parts.push(chunk);

    remaining = remaining.slice(cut).trim();
  }

  if (remaining.length > 0) parts.push(remaining);

  return parts;
}