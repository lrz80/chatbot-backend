import OpenAI from "openai";

export type Emocion =
  | "enfado"
  | "frustracion"
  | "neutral"
  | "interes"
  | "entusiasmo";

export async function detectarEmocion(texto: string, idioma: "es" | "en" = "es"): Promise<Emocion> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

  const prompt = `
Clasifica la emoción principal del mensaje del cliente.
Devuelve SOLO una palabra de esta lista:
enfado, frustracion, neutral, interes, entusiasmo

Idioma: ${idioma}
Mensaje: """${texto}"""
  `.trim();

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  });

  const out = (r.choices[0]?.message?.content || "").trim().toLowerCase();

  const allowed = new Set<Emocion>(["enfado","frustracion","neutral","interes","entusiasmo"]);
  return (allowed.has(out as Emocion) ? (out as Emocion) : "neutral");
}
