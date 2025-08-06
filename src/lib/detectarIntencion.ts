// src/lib/detectarIntencion.ts
import OpenAI from 'openai';

export async function detectarIntencion(mensaje: string) {
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || '',
  });

  const texto = mensaje.toLowerCase()
    .normalize('NFD') // Quita tildes
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

  const reglas = [
    {
      intencion: 'saludo',
      nivel_interes: 1,
      keywords: ['hola', 'hello', 'hi', 'buenos dias', 'buenas tardes', 'buenas noches', 'saludos', 'hey'],
    },
    {
      intencion: 'ubicacion',
      nivel_interes: 2,
      keywords: ['ubicacion', 'donde estan', 'donde queda', 'direccion', 'como llegar', 'ubicados', 'localizacion', 'location', 'address', 'where are you', 'how to get'],
    },
    {
      intencion: 'precio',
      nivel_interes: 2,
      keywords: ['cuanto cuesta', 'precio', 'precios', 'vale', 'tarifa', 'coste', 'cuesta', 'cobran', 'cost', 'price', 'how much'],
    },
    {
      intencion: 'horario',
      nivel_interes: 2,
      keywords: ['horario', 'horarios', 'a que hora', 'hora de apertura', 'hora de cierre', 'disponibilidad', 'schedule', 'time', 'what time', 'class time', 'what are the schedules'],
    },
    {
      intencion: 'reservar',
      nivel_interes: 3,
      keywords: ['reservar', 'reserva', 'quiero agendar', 'quiero apartar', 'hacer una cita', 'quiero una clase', 'agendar', 'book', 'appointment', 'book a class', 'i want to book'],
    },
    {
      intencion: 'cancelar',
      nivel_interes: 2,
      keywords: ['cancelar', 'anular', 'ya no quiero', 'me arrepenti', 'cancela mi', 'cancel'],
    },
    {
      intencion: 'no_interesado',
      nivel_interes: 1,
      keywords: ['no me interesa', 'no quiero', 'no gracias', 'ya no', 'no estoy interesado', 'not interested', 'i dont want', 'i am not interested'],
    }
  ];

  // 🔍 Nueva detección específica para mensajes tipo "interesado en clases"
  const compraKeywords = [
    // Inglés
    'looking for', 'interested in', 'want to know', 'i want classes',
    'classes for', 'class for my', 'my wife is looking', 'seeking classes',
    'i am looking for', 'i need classes', 'looking to enroll', 'do you offer classes',
  
    // Español
    'busco clases', 'estoy buscando clases', 'quiero clases',
    'mi esposa quiere clases', 'mi esposa busca clases',
    'interesado en clases', 'clases disponibles', 'ofrecen clases',
    'dan clases', 'tienen clases', 'necesito clases', 'como inscribirme',
    'deseo clases', 'como registrarse', 'informacion de clases'
  ];  

  if (compraKeywords.some(k => texto.includes(k))) {
    return {
      intencion: 'interes_clases',
      nivel_interes: 3,
    };
  }

  for (const regla of reglas) {
    if (regla.keywords.some(k => texto.includes(k))) {
      return {
        intencion: regla.intencion,
        nivel_interes: regla.nivel_interes,
      };
    }
  }

  // 🧠 Fallback con OpenAI en multilenguaje
  const prompt = `
You are a system that classifies customer messages into intent and interest level.

Analyze this message:
"${mensaje}"

Classify based on these possible intents:
- "comprar"
- "pagar"
- "precio"
- "reservar"
- "ubicacion"
- "cancelar"
- "saludo"
- "duda"
- "no_interesado"
- "interes_clases"

And these levels of interest:
- 1: Low (curious, not ready)
- 2: Medium (interested, but not urgent)
- 3: High (wants to book or pay now)

If the message includes interest in classes (e.g., "looking for classes", "busco clases", "quiero clases"), use intent "interes_clases" and level 3.
If the message contains any negative expressions like "I don't want", "no quiero", or "not interested", set intent to "no_interesado".

Respond **only** in JSON in the following format:
{
  "intencion": "one of the above",
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
