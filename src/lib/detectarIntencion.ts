// ✅ backend/src/lib/detectarIntencion.ts

// Esta función analiza el mensaje y devuelve la intención de compra y el nivel de interés.

export async function detectarIntencion(mensaje: string) {
    const { default: OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
  
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
  
    try {
      const respuesta = await openai.chat.completions.create({
        model: 'gpt-4-turbo',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
      });
  
      const content = respuesta.choices[0]?.message?.content || '{}';
      const data = JSON.parse(content);
  
      return {
        intencion: data.intencion || 'no_detectada',
        nivel_interes: data.nivel_interes || 1,
      };
    } catch (err) {
      console.error('❌ Error detectando intención:', err);
      return {
        intencion: 'error',
        nivel_interes: 1,
      };
    }
  }
  