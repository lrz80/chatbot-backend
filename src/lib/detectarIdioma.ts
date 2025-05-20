// src/lib/detectarIdioma.ts
import OpenAI from 'openai';

export async function detectarIdioma(texto: string): Promise<string> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

  const respuesta = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      {
        role: 'user',
        content: `Detecta el idioma de este mensaje y responde solo con el código ISO 639-1 (por ejemplo: en, es, pt):\n\n"${texto}"`,
      },
    ],
    temperature: 0,
  });

  const idioma = respuesta.choices[0]?.message?.content?.trim().toLowerCase();
  return idioma || 'es';
}
