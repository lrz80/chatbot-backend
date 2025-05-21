import pool from './db';
import { getPromptPorCanal, getBienvenidaPorCanal } from './getPromptPorCanal';
import { normalizarTexto } from './normalizarTexto';
import OpenAI from 'openai';

export async function getRespuestaCompleta({
  canal,
  tenant,
  input,
  idioma = 'es',
}: {
  canal: string;
  tenant: any;
  input: string;
  idioma?: string; // ✅ agregado aquí
}): Promise<string> {
  const mensajeDefault = idioma === 'en'
    ? 'Sorry, I don’t have an answer for that at the moment.'
    : 'Lo siento, no tengo una respuesta para eso en este momento.';

  const prompt = getPromptPorCanal(canal, tenant);
  const bienvenida = getBienvenidaPorCanal(canal, tenant);
  const mensaje = normalizarTexto(input);

  // 1. FAQs
  const faqsRes = await pool.query(
    'SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1 AND (idioma = $2 OR idioma IS NULL)',
    [tenant.id, idioma]
  );
  
  const faqs = faqsRes.rows || [];
  for (const faq of faqs) {
    if (mensaje.includes(normalizarTexto(faq.pregunta))) return faq.respuesta;
  }

  // 2. Intents
  const intentsRes = await pool.query(
    'SELECT * FROM intents WHERE tenant_id = $1 AND (idioma = $2 OR idioma IS NULL)',
    [tenant.id, idioma]
  );
  
  const intents = intentsRes.rows || [];
  for (const intent of intents) {
    if ((intent.ejemplos || []).some((ej: string) => mensaje.includes(normalizarTexto(ej)))) {
      return intent.respuesta;
    }
  }

  // 3. OpenAI fallback solo si no encontró FAQs ni Intents
  if (prompt) {
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || '',
    });

    const respuestaIA = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: input },
      ],
      max_tokens: 300,
    });

    return respuestaIA.choices[0]?.message.content?.trim() || bienvenida || mensajeDefault;
  }

  return bienvenida || mensajeDefault;
}
