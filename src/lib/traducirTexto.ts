import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// Cache simple en memoria
const cache = new Map<string, string>();
const CACHE_VERSION = "v4_catalog_labels";

export async function traducirTexto(
  texto: string,
  idioma: string,
  mode: "default" | "catalog_label" = "default"
): Promise<string> {
  if (!texto) return "";

  const key = `${CACHE_VERSION}::${mode}::${texto}::${idioma}`;
  if (cache.has(key)) return cache.get(key)!;

  // ===============================
  // 🔒 PROTEGER TOKENS
  // ===============================
  const protectedTokens: string[] = [];
  const freeze = (match: string) => {
    const token = `__KEEP_${protectedTokens.length}__`;
    protectedTokens.push(match);
    return token;
  };

  // URLs
  let protectedText = texto.replace(/https?:\/\/\S+/gi, freeze);

  // Emails
  protectedText = protectedText.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    freeze
  );

  // Dinero
  protectedText = protectedText.replace(
    /(\$\s*\d+(?:\.\d{1,2})?)|(\b\d+(?:\.\d{1,2})?\s*(?:usd|eur|gbp)\b)/gi,
    freeze
  );

  // Números
  protectedText = protectedText.replace(
    /\b\d+(?:[.,]\d+)?(?:%|\/\d+)?(?::\d{2})?\b/g,
    freeze
  );

  const extraRules =
    mode === "catalog_label"
      ? `
REGLAS EXTRA DE CATÁLOGO:
- Traduce como nombres comerciales naturales de productos, servicios o planes.
- NO hagas traducción literal palabra por palabra si produce frases poco naturales.
- Conserva exactamente números, precios, símbolos y tokens __KEEP_X__.
`
      : "";

  const prompt = `
Traduce el siguiente texto al idioma "${idioma}".

REGLAS OBLIGATORIAS:
- NO cambies ningún número, símbolo ($), moneda, porcentaje ni tokens __KEEP_X__.
- NO reordenes líneas. Mantén EXACTAMENTE el mismo orden.
- NO cambies el formato de viñetas ni los saltos de línea.
- Solo traduce palabras.
${extraRules}

Texto:
${protectedText}
`.trim();

  const response = await client.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
  });

  let translated = response.output_text.trim();

  // ===============================
  // 🔓 RESTAURAR TOKENS
  // ===============================
  protectedTokens.forEach((val, i) => {
    const token = `__KEEP_${i}__`;
    translated = translated.split(token).join(val);
  });

  cache.set(key, translated);

  return translated;
}