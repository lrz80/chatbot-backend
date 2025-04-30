// ✅ backend/src/lib/detectarIntencion.ts

import OpenAI from 'openai';

export async function detectarIntencion(mensaje: string) {
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || '',
  });

  const prompt = `
Analiza este mensaje de un cliente:

"${mensaje}"

Identifica:
- Intención de compra (por ejemplo: pedir precios, reservar cita, ubicación, cancelar, etc.).
- Nivel de interés (de 1 a 5, siendo 5 "muy interesado en comprar").

Responde solo en JSON. Ejemplo:
{
  "intencion": "preguntar precios",
  "nivel_interes": 4
}
`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4-turbo',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
  });

  let content = completion.choices[0]?.message?.content || '{}';

  // ✅ Limpiar formato markdown si viene con ```
  content = content.replace(/```json|```/g, '').trim();

  const data = JSON.parse(content);

  return {
    intencion: data.intencion || 'no_detectada',
    nivel_interes: data.nivel_interes || 1,
  };
}
