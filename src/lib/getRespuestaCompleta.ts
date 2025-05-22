import pool from './db';
import { getPromptPorCanal, getBienvenidaPorCanal } from './getPromptPorCanal';
import { normalizarTexto } from './normalizarTexto';
import { traducirTexto } from './traducirTexto';
import OpenAI from 'openai';

function preservarLinks(texto: string): { textoSinLinks: string; links: string[] } {
  const links: string[] = [];
  const textoSinLinks = texto.replace(/https?:\/\/\S+/g, (match) => {
    links.push(match);
    return `{{LINK_${links.length - 1}}}`;
  });
  return { textoSinLinks, links };
}

function restaurarLinks(texto: string, links: string[]): string {
  return texto.replace(/{{LINK_(\d+)}}/g, (_, index) => links[Number(index)] || '');
}

export async function getRespuestaCompleta({
  canal,
  tenant,
  input,
  idioma = 'es',
}: {
  canal: string;
  tenant: any;
  input: string;
  idioma?: string;
}): Promise<string> {
  const mensajeDefault = idioma === 'en'
    ? 'Sorry, I don’t have an answer for that at the moment.'
    : 'Lo siento, no tengo una respuesta para eso en este momento.';

  let prompt = getPromptPorCanal(canal, tenant);
  const bienvenida = getBienvenidaPorCanal(canal, tenant);
  const mensaje = normalizarTexto(input);

  // 🌐 Traducir el prompt si el idioma no es español
  if (idioma !== 'es') {
    try {
      const { textoSinLinks, links } = preservarLinks(prompt);
      const textoTraducido = await traducirTexto(textoSinLinks, idioma);
      prompt = restaurarLinks(textoTraducido, links);
    } catch (err) {
      console.warn('⚠️ No se pudo traducir el prompt:', err);
    }
  }

  // 1. FAQs
  const faqsRes = await pool.query(
    'SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1',
    [tenant.id]
  );
  const faqs = faqsRes.rows || [];
  for (const faq of faqs) {
    if (mensaje.includes(normalizarTexto(faq.pregunta))) return faq.respuesta;
  }

  // 2. Intents
  const intentsRes = await pool.query(
    'SELECT * FROM intents WHERE tenant_id = $1',
    [tenant.id]
  );
  const intents = intentsRes.rows || [];
  for (const intent of intents) {
    if ((intent.ejemplos || []).some((ej: string) => mensaje.includes(normalizarTexto(ej)))) {
      return intent.respuesta;
    }
  }

  // 3. Fallback con OpenAI
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
