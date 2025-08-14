// src/lib/detectarIntencion.ts
import OpenAI from 'openai';

type Intento = { intencion: string; nivel_interes: number };

const stripDiacritics = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const norm = (s: string) =>
  stripDiacritics(s.toLowerCase().trim());

/** Quita saludos SOLO si están al principio y deja el resto del mensaje */
function stripLeadingGreeting(t: string) {
  const re = /^(hola|hello|hi|hey|buenos dias|buenas tardes|buenas noches)[\s,!.:-]*\b/i;
  return t.replace(re, '').trim();
}

/** Coincidencia por palabra (para términos de 1 palabra); para frases usa includes(). */
function hasWord(text: string, word: string) {
  const w = stripDiacritics(word.toLowerCase());
  return new RegExp(`\\b${w}\\b`, 'i').test(text);
}

export async function detectarIntencion(mensaje: string, tenantId: string): Promise<Intento> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

  // Normalización
  const original = (mensaje || '').trim();
  let texto = norm(original);

  // 1) Quitar saludo al INICIO y analizar el resto
  const textoCore = norm(stripLeadingGreeting(original)) || texto;

  // 2) Reglas rápidas (prioridades)
  // 2.1 Pedir información (prioritaria)
  const pedirInfoPhrases = [
    'mas informacion', 'más informacion', 'quiero informacion', 'necesito saber mas',
    'quiero saber mas', 'quisiera saber mas', 'puedes decirme mas', 'quiero detalles',
    'me puedes explicar', 'en que consiste', 'tell me more', 'more info',
    'more information', 'i want information', 'i need more info', 'information please'
  ];
  const pedirInfoWords = ['info', 'informacion', 'information'];

  const pedirInfo =
    pedirInfoPhrases.some(p => textoCore.includes(norm(p))) ||
    pedirInfoWords.some(w => hasWord(textoCore, w));

  if (pedirInfo) {
    return { intencion: 'pedir_info', nivel_interes: 2 };
  }

  // 2.2 Interés en clases (tu regla especial)
  const compraKeywords = [
    // Inglés
    'looking for', 'interested in', 'want to know', 'i want classes',
    'classes for', 'class for my', 'seeking classes', 'i am looking for',
    'i need classes', 'looking to enroll', 'do you offer classes',
    // Español
    'busco clases', 'estoy buscando clases', 'quiero clases',
    'mi esposa quiere clases', 'mi esposa busca clases',
    'interesado en clases', 'clases disponibles', 'ofrecen clases',
    'dan clases', 'tienen clases', 'necesito clases', 'como inscribirme',
    'deseo clases', 'como registrarse', 'informacion de clases'
  ];
  if (compraKeywords.some(k => textoCore.includes(norm(k)))) {
    return { intencion: 'interes_clases', nivel_interes: 3 };
  }

  // 2.3 Otras intenciones con keywords
  const reglas = [
    {
      intencion: 'ubicacion', nivel_interes: 2,
      words: ['ubicacion','direccion','localizacion','location','address'],
      phrases: ['donde estan','donde queda','como llegar','where are you','how to get']
    },
    {
      intencion: 'precio', nivel_interes: 2,
      words: ['precio','precios','cost','price'],
      phrases: ['cuanto cuesta','how much','tarifa','vale','cuesta','cobran']
    },
    {
      intencion: 'horario', nivel_interes: 2,
      words: ['horario','horarios','schedule','time'],
      phrases: ['a que hora','hora de apertura','hora de cierre','what time','class time','what are the schedules']
    },
    {
      intencion: 'reservar', nivel_interes: 3,
      words: ['reservar','reserva','agendar','book','appointment'],
      phrases: ['quiero agendar','quiero apartar','hacer una cita','book a class','i want to book']
    },
    {
      intencion: 'cancelar', nivel_interes: 2,
      words: ['cancelar','cancel'],
      phrases: ['anular','cancela mi','ya no quiero','me arrepenti']
    },
    {
      intencion: 'no_interesado', nivel_interes: 1,
      words: [],
      phrases: ['no me interesa','no quiero','no gracias','ya no','not interested','i dont want','i am not interested']
    },
    // 👇 Saludo queda al final (menor prioridad)
    {
      intencion: 'saludo', nivel_interes: 1,
      words: ['hola','hello','hi','saludos','hey'],
      phrases: ['buenos dias','buenas tardes','buenas noches']
    }
  ] as const;

  for (const r of reglas) {
    const hitWord = r.words.some(w => hasWord(textoCore, w));
    const hitPhrase = r.phrases.some(p => textoCore.includes(norm(p)));
    if (hitWord || hitPhrase) return { intencion: r.intencion, nivel_interes: r.nivel_interes };
  }

  // 3) Fallback LLM (multilenguaje)
  const prompt = `
You classify customer messages into intent and interest.
Message: "${original}"

Intents:
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
- "pedir_info"

Rules:
- If greeting + request (e.g., "Hello, I want more information"), DO NOT return "saludo"; prefer "pedir_info".
- If message shows interest in classes, return "interes_clases" (level 3).
- If negative expressions like "no quiero" / "not interested", return "no_interesado".

Interest levels:
1 = low, 2 = medium, 3 = high.

Return ONLY JSON:
{"intencion":"...","nivel_interes":1|2|3}
`.trim();

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    });

    let content = (completion.choices[0]?.message?.content || '{}')
      .replace(/```json|```/g, '')
      .trim();

    const parsed = JSON.parse(content) as Intento;
    if (parsed?.intencion) {
      // post-corrección: si el modelo devolviera "saludo" pero el texto pide info, corrige.
      if (parsed.intencion === 'saludo' && pedirInfo) {
        return { intencion: 'pedir_info', nivel_interes: Math.max(2, parsed.nivel_interes || 2) };
      }
      return {
        intencion: parsed.intencion.toLowerCase(),
        nivel_interes: Math.min(3, Math.max(1, Number(parsed.nivel_interes) || 1)),
      };
    }
  } catch (e) {
    console.error('❌ Error en fallback LLM:', e);
  }

  return { intencion: 'duda', nivel_interes: 1 };
}
