import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// Cache simple en memoria para no traducir lo mismo 200 veces
const cache = new Map<string, string>();

export async function traducirTexto(texto: string, idioma: string): Promise<string> {
  if (!texto) return "";

  const key = `${texto}::${idioma}`;
  if (cache.has(key)) return cache.get(key)!;

  const prompt = `
Traduce el siguiente texto al idioma "${idioma}".
Respeta nombres propios, formatos y no inventes nada.
Devuélvelo sin agregar comentarios.

Texto:
${texto}
  `.trim();

  const response = await client.responses.create({
    model: "gpt-4.1-mini",   // ⚡ muchísimo más rápido y barato para traducción
    input: prompt,
  });

  const translated = response.output_text.trim();
  cache.set(key, translated);

  return translated;
}