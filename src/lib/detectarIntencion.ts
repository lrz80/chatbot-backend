// src/lib/detectarIntencion.ts
import OpenAI from 'openai';
import pool from './db'; // 👈 Para cargar info del tenant

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

  // 📌 Cargar info del tenant para contextualizar
  let tenantInfo = '';
  try {
    const res = await pool.query(
      `SELECT nombre, categoria, funciones_asistente, info_clave 
       FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId]
    );
    if (res.rows.length > 0) {
      const t = res.rows[0];
      tenantInfo = `
Negocio: ${t.nombre || ''}
Categoría: ${t.categoria || ''}
Funciones del asistente: ${t.funciones_asistente || ''}
Información clave: ${t.info_clave || ''}
      `.trim();
    }
  } catch (e) {
    console.error('❌ Error cargando tenant info en detectarIntencion:', e);
  }

  // Normalización
  const original = (mensaje || '').trim();
  let texto = norm(original);

  // 1) Quitar saludo al INICIO y analizar el resto
  const textoCore = norm(stripLeadingGreeting(original)) || texto;

  // 2) Reglas rápidas (prioridades)
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

  const compraKeywords = [
    'looking for', 'interested in', 'want to know', 'i want classes',
    'classes for', 'class for my', 'seeking classes', 'i am looking for',
    'i need classes', 'looking to enroll', 'do you offer classes',
    'busco clases', 'estoy buscando clases', 'quiero clases',
    'mi esposa quiere clases', 'mi esposa busca clases',
    'interesado en clases', 'clases disponibles', 'ofrecen clases',
    'dan clases', 'tienen clases', 'necesito clases', 'como inscribirme',
    'deseo clases', 'como registrarse', 'informacion de clases'
  ];
  if (compraKeywords.some(k => textoCore.includes(norm(k)))) {
    return { intencion: 'interes_clases', nivel_interes: 3 };
  }

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

  // 3) Fallback LLM con contexto multitenant
  const prompt = `
Eres un clasificador de mensajes de clientes para un asistente de IA.  
Debes clasificar considerando el contexto del negocio.

Contexto del tenant:
${tenantInfo}

Mensaje del cliente: "${original}"

Posibles intenciones:
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

Reglas:
- Si hay saludo + petición, no devuelvas "saludo"; prioriza la intención real.
- Si el mensaje muestra interés en clases, devuelve "interes_clases" (nivel 3).
- Si hay frases negativas como "no quiero", devuelve "no_interesado".

Nivel de interés:
1 = bajo, 2 = medio, 3 = alto.

Devuelve SOLO JSON:
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
