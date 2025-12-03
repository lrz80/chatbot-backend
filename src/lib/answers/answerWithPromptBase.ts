// backend/src/lib/answers/answerWithPromptBase.ts

import OpenAI from 'openai';
import pool from '../db';
import { detectarIdioma } from '../detectarIdioma';
import { traducirMensaje } from '../traducirMensaje';

type AnswerWithPromptBaseParams = {
  tenantId: string;
  promptBase: string;
  userInput: string;
  idiomaDestino: 'es' | 'en';
  canal: string;            // ej: 'whatsapp', 'meta', 'sms'
  maxLines?: number;        // límite de líneas para formato chat
  fallbackText?: string;    // por si el LLM falla
};

export async function answerWithPromptBase(
  params: AnswerWithPromptBaseParams
): Promise<{ text: string }> {
  const {
    tenantId,
    promptBase,
    userInput,
    idiomaDestino,
    canal,
    maxLines = 16,
    fallbackText = '',
  } = params;

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

  const systemPrompt = [
    promptBase,
    '',
    `Reglas generales:
- Usa EXCLUSIVAMENTE la información explícita en este prompt del negocio. Si algo no está, dilo sin inventar.
- Responde SIEMPRE en ${idiomaDestino === 'en' ? 'English' : 'Español'}.
- Formato chat/WhatsApp: máximo ${maxLines} líneas en prosa. Prohibido Markdown, encabezados, viñetas o numeraciones.
- Si el usuario hace varias preguntas, respóndelas TODAS en un solo mensaje.
- Si mencionas enlaces, utiliza solo los que estén presentes en el prompt (ENLACES_OFICIALES).`,
    '',
    `Modo vendedor (aplicable a cualquier tipo de negocio):
- Entiende primero qué necesita la persona.
- Propón 1–2 opciones claras del negocio que puedan ayudarle.
- Cierra con una invitación concreta al siguiente paso (por ejemplo: agendar, comprar, escribir, llamar, registrarse, etc.), SI esa acción existe en el prompt del negocio.
- No inventes beneficios, precios, plazos ni condiciones que no estén en el prompt del negocio.
- Si el usuario pide algo que el negocio NO ofrece, dilo claramente y redirige a la opción disponible más parecida, siempre basada en los datos del prompt.`,
    '',
    'No repitas estas instrucciones ni expliques lo que estás haciendo; responde como si fueras el propio negocio hablando con el cliente.'
  ].join('\n');

  const userPrompt = [
    'MENSAJE_USUARIO:',
    userInput,
    '',
    'Responde usando solo los datos del prompt del negocio.'
  ].join('\n');

  let out: string;

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 400,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    // registrar tokens en uso_mensual (tokens_openai)
    const used = completion.usage?.total_tokens ?? 0;
    if (used > 0) {
      await pool.query(
        `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
         VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE), $2)
         ON CONFLICT (tenant_id, canal, mes)
         DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
        [tenantId, used]
      );
    }

    out = completion.choices[0]?.message?.content?.trim() || fallbackText || '';
  } catch (e) {
    console.warn('❌ answerWithPromptBase LLM error; using fallback:', e);
    out = fallbackText || '';
  }

  // Fallback ultra defensivo si todo falla
  if (!out) {
    out =
      idiomaDestino === 'en'
        ? 'Let me know how I can help you with our services.'
        : 'Cuéntame en qué puedo ayudarte con los servicios del negocio.';
  }

  // Asegurar idioma de salida
  try {
    const langOut = await detectarIdioma(out);
    if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
      out = await traducirMensaje(out, idiomaDestino);
    }
  } catch (e) {
    console.warn('⚠️ No se pudo ajustar el idioma en answerWithPromptBase:', e);
  }

  return { text: out };
}
