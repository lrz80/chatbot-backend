import OpenAI from "openai";
import { EMOCIONES_PERMITIDAS, Emocion } from "./emotion/categories";

export async function detectarEmocion(
  texto: string,
  idioma: "es" | "en" = "es"
): Promise<Emocion> {

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

  // Lista dinámica
  const lista = EMOCIONES_PERMITIDAS.join(", ");

  const prompt = `
Clasifica la emoción principal del mensaje del cliente.
Debes responder con UNA SOLA palabra. 
Estas son las categorías disponibles: ${lista}

Idioma: ${idioma}
Mensaje: """${texto}"""
  `.trim();

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  });

  const out = (r.choices[0]?.message?.content || "")
    .trim()
    .toLowerCase();

  // Valida contra la lista centralizada
  return (EMOCIONES_PERMITIDAS as readonly string[]).includes(out)
    ? (out as Emocion)
    : "neutral";
}
