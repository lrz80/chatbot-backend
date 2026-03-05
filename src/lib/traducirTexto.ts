import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// Cache simple en memoria para no traducir lo mismo 200 veces
const cache = new Map<string, string>();
const CACHE_VERSION = "v2_prices_frozen";

export async function traducirTexto(texto: string, idioma: string): Promise<string> {
  if (!texto) return "";

  const key = `${CACHE_VERSION}::${texto}::${idioma}`;
  if (cache.has(key)) return cache.get(key)!;

  // ===============================
  // 🔒 PROTEGER TOKENS NO-TRADUCIBLES
  // ===============================
  const protectedTokens: string[] = [];
  const freeze = (match: string) => {
    const token = `__KEEP_${protectedTokens.length}__`;
    protectedTokens.push(match);
    return token;
  };

  // 1) URLs
  let protectedText = texto.replace(/https?:\/\/\S+/gi, freeze);

  // 2) Emails
  protectedText = protectedText.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    freeze
  );

  // 3) Dinero: $59.99, 59.99 USD, etc.
  protectedText = protectedText.replace(
    /(\$\s*\d+(?:\.\d{1,2})?)|(\b\d+(?:\.\d{1,2})?\s*(?:usd|eur|gbp)\b)/gi,
    freeze
  );

  // 4) Cualquier número/formatos numéricos (24/7, 7 days, 10:30, 3 months, etc.)
  protectedText = protectedText.replace(
    /\b\d+(?:[.,]\d+)?(?:%|\/\d+)?(?::\d{2})?\b/g,
    freeze
  );

  const prompt = `
Traduce el siguiente texto al idioma "${idioma}".
Respeta nombres propios, formatos y no inventes nada.
NO modifiques tokens como __PRICE_0__, __PRICE_1__, etc.
Devuélvelo sin agregar comentarios.
NO modifiques ni reordenes tokens __KEEP_N__. Deben permanecer idénticos.

Texto:
${protectedText}
  `.trim();

  const response = await client.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
  });

  let translated = response.output_text.trim();

  // ===============================
  // 🔓 RESTAURAR EXACTO (TODAS las ocurrencias)
  // ===============================
  protectedTokens.forEach((val, i) => {
    const token = `__KEEP_${i}__`;
    translated = translated.split(token).join(val);
  });

  cache.set(key, translated);

  return translated;
}