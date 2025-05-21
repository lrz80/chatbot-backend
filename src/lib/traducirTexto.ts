import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export async function traducirTexto(texto: string, idioma: string): Promise<string> {
  const prompt = `Traduce el siguiente mensaje al idioma "${idioma}". Solo responde con la traducción:\n\n"${texto}"`;

  const res = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
  });

  return res.choices[0]?.message?.content?.trim() || texto;
}
