// backend/src/lib/services/pricing/priceSummaryTokens.ts

export type GenericPriceRow = {
  service_name: string;
  min_price: number;
  max_price: number;
};

/**
 * Extrae tokens "con significado" para filtrar servicios
 * a partir de una pregunta de precios.
 *
 * No contiene palabras por industria; solo elimina
 * palabras genéricas de precio.
 */
export function extractMeaningfulTokensForPricing(text: string): string[] {
  const t = String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const rawTokens = t
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const STOP = new Set([
    // ES genéricos de precio
    "precio", "precios", "tarifa", "tarifas", "costo", "costos",
    "cuanto", "cuantos", "cuanta", "cuantas",
    "cuesta", "cuestan", "vale", "valen",
    "que", "cual", "cuales", "son", "es", "de", "del", "la", "las",
    "el", "los", "un", "una", "unos", "unas", "por", "para", "en", "al",
    // EN genéricos de precio
    "price", "prices", "pricing", "cost", "costs",
    "how", "much", "what", "are", "the", "is", "do", "you", "have",
  ]);

  return rawTokens
    .map((tok) => {
      // singularizar muy simple: "clases" -> "clase", "packages" -> "package"
      if (tok.length > 4 && tok.endsWith("s")) return tok.slice(0, -1);
      return tok;
    })
    .filter((tok) => tok.length >= 3 && !STOP.has(tok));
}

/**
 * Filtra filas de resumen de precio usando los tokens significativos.
 * Si el filtro deja 0 filas, devuelve las originales.
 */
export function filterRowsByMeaningfulTokens<T extends { service_name: string }>(
  rows: T[],
  userInput: string
): T[] {
  if (!rows || !rows.length) return rows;

  const meaningTokens = extractMeaningfulTokensForPricing(userInput);
  if (!meaningTokens.length) return rows;

  const filtered = rows.filter((r) => {
    const nameNorm = String(r.service_name || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();

    return meaningTokens.some((tok) => nameNorm.includes(tok));
  });

  return filtered.length ? filtered : rows;
}