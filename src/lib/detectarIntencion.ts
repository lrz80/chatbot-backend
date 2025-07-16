// src/lib/detectarIntencion.ts
import OpenAI from 'openai';

export async function detectarIntencion(mensaje: string) {
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || '',
  });

  const texto = mensaje.toLowerCase();

  // 🧠 Refuerzos manuales por palabra clave
  const reglas = [
    {
      intencion: 'saludo',
      nivel_interes: 1,
      keywords: ['hola', 'hello', 'buenos días', 'buenas tardes', 'buenas noches', 'saludos'],
    },
    {
      intencion: 'ubicacion',
      nivel_interes: 2,
      keywords: ['ubicación', 'ubicacion', 'donde están', 'dónde están', 'donde queda', 'dirección', 'direccion', 'cómo llegar', 'como llegar', 'ubicados', 'localización', 'localizacion'],
    },
    {
      intencion: 'precio',
      nivel_interes: 2,
      keywords: ['cuánto cuesta', 'cuanto cuesta', 'precio', 'precios', 'vale', 'tarifa', 'coste', 'cuesta', 'cobran'],
    },
    {
      intencion: 'horario',
      nivel_interes: 2,
      keywords: ['horario', 'horarios', 'a qué hora', 'a que hora', 'abren', 'cierran', 'hora de apertura', 'hora de cierre', 'disponibilidad'],
    },
    {
      intencion: 'reservar',
      nivel_interes: 3,
      keywords: ['reservar', 'reserva', 'quiero agendar', 'quiero apartar', 'hacer una cita', 'quiero una clase'],
    },
    {
      intencion: 'cancelar',
      nivel_interes: 2,
      keywords: ['cancelar', 'anular', 'ya no quiero', 'me arrepentí', 'cancela mi'],
    },
    {
      intencion: 'no_interesado',
      nivel_interes: 1,
      keywords: ['no me interesa', 'no quiero', 'no gracias', 'ya no', 'no estoy interesado'],
    }
  ];

  for (const regla of reglas) {
    if (regla.keywords.some(k => texto.includes(k))) {
      return {
        intencion: regla.intencion,
        nivel_interes: regla.nivel_interes,
      };
    }
  }

  // Si no se detectó manualmente, usa OpenAI
  const prompt = `
Eres un sistema que analiza mensajes de clientes para clasificar su intención y nivel de interés.

Analiza el siguiente mensaje:
"${mensaje}"

Clasifica según estas intenciones posibles:
- "comprar"
- "pagar"
- "precio"
- "reservar"
- "ubicacion"
- "cancelar"
- "saludo"
- "duda"
- "no_interesado"

Y estos niveles de interés:
- 1: Bajo (curioso, sin intención clara)
- 2: Medio (interesado pero no decidido)
- 3: Alto (quiere comprar o reservar pronto)

Si el mensaje es un saludo como "hola", "buenas", "hello", "saludos", etc., la intención debe ser "saludo" y el nivel_interes debe ser 1.

⚠️ Si el mensaje contiene una negación como "no quiero pagar" o "no me interesa", la intención debe ser "no_interesado".

Responde solo en JSON con este formato exacto:
{
  "intencion": "una de las opciones anteriores",
  "nivel_interes": 1 | 2 | 3
}
`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4-turbo',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
  });

  let content = completion.choices[0]?.message?.content || '{}';
  content = content.replace(/```json|```/g, '').trim();

  let data: { intencion: string; nivel_interes: number } = {
    intencion: 'no_detectada',
    nivel_interes: 1,
  };

  try {
    const parsed = JSON.parse(content);
    if (parsed.intencion && parsed.nivel_interes) {
      data = {
        intencion: parsed.intencion.toLowerCase(),
        nivel_interes: Math.min(3, Math.max(1, parseInt(parsed.nivel_interes))),
      };
    }
  } catch (error) {
    console.error('❌ Error parseando intención:', error);
  }

  return data;
}
