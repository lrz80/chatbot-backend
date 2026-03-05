import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// Cache simple en memoria para no traducir lo mismo 200 veces
const cache = new Map<string, string>();

export async function traducirTexto(texto: string, idioma: string): Promise<string> {
  if (!texto) return "";

  const key = `${texto}::${idioma}`;
  if (cache.has(key)) return cache.get(key)!;

  // ===============================
  // 🔒 PROTEGER PRECIOS Y NÚMEROS
  // ===============================
  const priceRegex =
    /\$\s?\d+(?:\.\d{1,2})?|\b\d+(?:\.\d{1,2})?\s?(?:usd|eur|gbp)\b|\b\d+\.\d{2}\b/gi;

  const protectedTokens: string[] = [];
  let protectedText = texto.replace(priceRegex, (match) => {
    const token = `__PRICE_${protectedTokens.length}__`;
    protectedTokens.push(match);
    return token;
  });

  const prompt = `
Traduce el siguiente texto al idioma "${idioma}".
Respeta nombres propios, formatos y no inventes nada.
NO modifiques tokens como __PRICE_0__, __PRICE_1__, etc.
Devuélvelo sin agregar comentarios.

Texto:
${protectedText}
  `.trim();

  const response = await client.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
  });

  let translated = response.output_text.trim();

  // ===============================
  // 🔓 RESTAURAR PRECIOS EXACTOS
  // ===============================
  protectedTokens.forEach((price, i) => {
    translated = translated.replace(`__PRICE_${i}__`, price);
  });

  cache.set(key, translated);

  return translated;
}