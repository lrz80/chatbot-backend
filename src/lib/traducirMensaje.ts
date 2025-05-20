// backend/src/lib/traducirMensaje.ts

import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

export async function traducirMensaje(texto: string, idiomaObjetivo: string): Promise<string> {
  try {
    const prompt = `Traduce el siguiente texto al idioma '${idiomaObjetivo}' manteniendo un tono amable y profesional:\n\n${texto}`;
    
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "Eres un traductor profesional." },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
    });

    const traduccion = response.choices[0]?.message?.content?.trim();
    return traduccion || texto;
  } catch (err) {
    console.error("❌ Error traduciendo mensaje:", err);
    return texto; // fallback al original si falla
  }
}
