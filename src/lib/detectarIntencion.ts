// src/lib/detectarIntencion.ts
import OpenAI from 'openai';
import pool from './db';

export type Intento = { intencion: string; nivel_interes: number }; // ⬅ export
export type Canal =
  | 'whatsapp'
  | 'facebook'
  | 'instagram'
  | 'voz'
  | 'preview'; // ⬅ export

const stripDiacritics = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const norm = (s: string) => stripDiacritics((s || '').toLowerCase().trim());

/** Quita saludos SOLO si están al principio y deja el resto del mensaje */
function stripLeadingGreeting(t: string) {
  const re = /^(hola|hello|hi|hey|buenos dias|buenas tardes|buenas noches)[\s,!.:-]*\b/i;
  return (t || '').replace(re, '').trim();
}

/** Coincidencia por palabra (para términos de 1 palabra); para frases usa includes(). */
function hasWord(text: string, word: string) {
  const w = stripDiacritics((word || '').toLowerCase());
  return new RegExp(`\\b${w}\\b`, 'i').test(text || '');
}

/** === Nuevo: catálogo de intenciones que cuentan como Venta (export) */
export const INTENT_VENTA = new Set<string>([
  'comprar',
  'pagar',
  'precio',
  'reservar',
  'interes_clases',
  'membresia',
  'planes'
]);

export function esIntencionDeVenta(raw: string): boolean {
  const s = (raw || '').toLowerCase();
  // Intenciones que cuentan como “venta”
  const ventas = [
    'precio', 'reservar', 'agendar', 'comprar', 'pagar',
    'confirmar', 'interes_clases', 'clases_online', 'me interesa'
  ];
  return ventas.some(v => s.includes(v));
}

export async function detectarIntencion(
  mensaje: string,
  tenantId: string,
  canal: Canal = 'whatsapp'
): Promise<Intento> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

  // 📌 Cargar info del tenant para contextualizar (multitenant)
  let tenantInfo = '';
  try {
    const res = await pool.query(
      `SELECT name AS nombre, categoria, funciones_asistente, info_clave
       FROM tenants
       WHERE id = $1
       LIMIT 1`,
      [tenantId]
    );
    if (res.rows.length > 0) {
      const t = res.rows[0];
      tenantInfo = `
Negocio: ${t.nombre || ''}
Categoría: ${t.categoria || ''}
Funciones del asistente: ${t.funciones_asistente || ''}
Información clave: ${t.info_clave || ''}
Canal: ${canal}
      `.trim();
    } else {
      tenantInfo = `Canal: ${canal}`; // fallback mínimo
    }
  } catch (e) {
    console.error('❌ Error cargando tenant info en detectarIntencion:', e);
    tenantInfo = `Canal: ${canal}`;
  }

  // Normalización
  const original = (mensaje || '').trim();
  const texto = norm(original);
  const textoCore = norm(stripLeadingGreeting(original)) || texto;

  // Heurísticas específicas por canal (multicanal)
  const canalHints: Record<Canal, string[]> = {
    whatsapp: ['whatsapp', 'wasap', 'wpp'],
    facebook: ['facebook', 'fb', 'messenger', 'inbox'],
    instagram: ['instagram', 'ig', 'insta', 'dm'],
    voz: ['llamar', 'llamada', 'call', 'phone', 'marcar'],
    preview: ['preview', 'demo', 'prueba']
  };
  const mencionaCanal = canalHints[canal].some(k => textoCore.includes(norm(k)));

  // 0) Flag de "pedir información" (NO devolvemos aún; dejamos que venta prevalezca)
  const pedirInfoPhrases = [
    'mas informacion',
    'más informacion',
    'quiero informacion',
    'necesito saber mas',
    'quiero saber mas',
    'quisiera saber mas',
    'puedes decirme mas',
    'quiero detalles',
    'me puedes explicar',
    'en que consiste',
    'tell me more',
    'more info',
    'more information',
    'i want information',
    'i need more info',
    'information please'
  ];
  const pedirInfoWords = ['info', 'informacion', 'information'];
  const flagPedirInfo =
    pedirInfoPhrases.some(p => textoCore.includes(norm(p))) ||
    pedirInfoWords.some(w => hasWord(textoCore, w));

  // 1) Intención fuerte: interés en clases / prueba gratuita
  const interesClasesPhrases = [
    'i want classes',
    'classes for',
    'class for my',
    'seeking classes',
    'i am looking for',
    'i need classes',
    'looking to enroll',
    'do you offer classes',
    'quiero clases',
    'busco clases',
    'estoy buscando clases',
    'interesado en clases',
    'clases disponibles',
    'ofrecen clases',
    'dan clases',
    'necesito clases',
    'como inscribirme',
    'como registrarse',
    'informacion de clases',
    'clase gratis',
    'primera clase gratis',
    'free class',
    'first class free',
    'trial class',
    'clase de prueba',
    'prueba gratuita'
  ];
  if (interesClasesPhrases.some(k => textoCore.includes(norm(k)))) {
    return { intencion: 'interes_clases', nivel_interes: 3 };
  }

  // 2) Reglas rápidas
  const reglas = [
    {
      intencion: 'ubicacion',
      nivel_interes: 2,
      words: ['ubicacion', 'dirección', 'direccion', 'localizacion', 'location', 'address'],
      phrases: ['donde estan', 'donde queda', 'como llegar', 'where are you', 'how to get']
    },
    {
      intencion: 'precio',
      nivel_interes: 2,
      words: ['precio', 'precios', 'cost', 'price', 'membresia', 'membresía', 'membership'],
      phrases: ['cuanto cuesta', 'how much', 'tarifa', 'vale', 'cuesta', 'cobran', 'precio de la clase']
    },
    {
      intencion: 'horario',
      nivel_interes: 2,
      words: ['horario', 'horarios', 'schedule', 'time'],
      phrases: ['a que hora', 'hora de apertura', 'hora de cierre', 'what time', 'class time', 'what are the schedules']
    },
    {
      intencion: 'reservar',
      nivel_interes: 3,
      words: ['reservar', 'reserva', 'agendar', 'book', 'appointment', 'inscribir', 'registrar'],
      phrases: ['quiero agendar', 'quiero apartar', 'hacer una cita', 'book a class', 'i want to book', 'agendar clase']
    },
    {
      intencion: 'cancelar',
      nivel_interes: 2,
      words: ['cancelar', 'cancel'],
      phrases: ['anular', 'cancela mi', 'ya no quiero', 'me arrepenti', 'me arrepentí']
    },
    {
      intencion: 'no_interesado',
      nivel_interes: 1,
      words: [],
      phrases: ['no me interesa', 'no quiero', 'no gracias', 'ya no', 'not interested', 'i dont want', 'i am not interested']
    },
    {
      intencion: 'saludo',
      nivel_interes: 1,
      words: ['hola', 'hello', 'hi', 'saludos', 'hey'],
      phrases: ['buenos dias', 'buenas tardes', 'buenas noches']
    }
  ] as const;

  for (const r of reglas) {
    const hitWord = r.words.some(w => hasWord(textoCore, w));
    const hitPhrase = r.phrases.some(p => textoCore.includes(norm(p)));
    if (hitWord || hitPhrase) return { intencion: r.intencion, nivel_interes: r.nivel_interes };
  }

  // 3) 🔥 Reglas explícitas de Venta (antes del LLM):
  //    cubre compra/planes/membresía/pago/join/signup/enroll
  const ventaKeywords = [
    'comprar',
    'compra',
    'pagar',
    'inscribirme',
    'inscripcion',
    'inscripción',
    'membresia',
    'membresía',
    'plan',
    'planes',
    'suscripcion',
    'suscripción',
    'join',
    'sign up',
    'signup',
    'enroll',
    'enrollment'
  ];
  if (ventaKeywords.some(w => textoCore.includes(norm(w)))) {
    // Si menciona reservar/agendar/book → reservar (nivel 3)
    if (['reservar', 'agendar', 'book', 'cita', 'appointment'].some(w => textoCore.includes(norm(w)))) {
      return { intencion: 'reservar', nivel_interes: 3 };
    }
    // Si menciona precio → precio (nivel 2)
    if (['precio', 'precios', 'price', 'cost', 'tarifa', 'cuesta', 'vale'].some(w => textoCore.includes(norm(w)))) {
      return { intencion: 'precio', nivel_interes: 2 };
    }
    // Por defecto, alta intención de clases/compra
    return { intencion: 'interes_clases', nivel_interes: 3 };
  }

  // 4) Señal de canal voz → intención "reservar" o "pedir_info" según contenido
  if (canal === 'voz' || mencionaCanal) {
    // Si pregunta por disponibilidad / horario, subir intención
    if (['horario', 'reservar', 'agendar', 'book', 'cita', 'call'].some(w => textoCore.includes(norm(w)))) {
      return { intencion: 'reservar', nivel_interes: 3 };
    }
    // Si es genérico
    if (flagPedirInfo) return { intencion: 'pedir_info', nivel_interes: 2 };
  }

  // 5) Si nada anterior aplicó y el usuario pide información genérica
  if (flagPedirInfo) return { intencion: 'pedir_info', nivel_interes: 2 };

  // 6) Fallback LLM con contexto multitenant + multicanal
  const prompt = `
Eres un clasificador de mensajes de clientes para un asistente de IA.
Debes clasificar considerando el contexto del negocio y el canal.

Contexto:
${tenantInfo}

Mensaje del cliente: "${original}"

Posibles intenciones (elige una):
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
- Si el mensaje muestra interés en clases o prueba gratuita, devuelve "interes_clases" (nivel 3).
- Si hay frases negativas como "no quiero", devuelve "no_interesado".
- Si el mensaje sugiere agendar/booking, devuelve "reservar" (nivel 3).

Nivel de interés:
1 = bajo, 2 = medio, 3 = alto.

Devuelve SOLO JSON:
{"intencion":"...","nivel_interes":1|2|3}
  `.trim();

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2
    });

    let content = (completion.choices[0]?.message?.content || '{}')
      .replace(/```json|```/g, '')
      .trim();

    const parsed = JSON.parse(content) as Intento;
    if (parsed?.intencion) {
      // Priorizar pedir_info sobre saludo si ambas aparecen
      if (parsed.intencion === 'saludo' && flagPedirInfo) {
        return { intencion: 'pedir_info', nivel_interes: Math.max(2, parsed.nivel_interes || 2) };
      }
      return {
        intencion: parsed.intencion.toLowerCase(),
        nivel_interes: Math.min(3, Math.max(1, Number(parsed.nivel_interes) || 1))
      };
    }
  } catch (e) {
    console.error('❌ Error en fallback LLM:', e);
  }

  return { intencion: 'duda', nivel_interes: 1 };
}
