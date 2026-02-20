import OpenAI from 'openai';
import pool from '../db';
import { detectarIdioma } from '../detectarIdioma';
import { traducirMensaje } from '../traducirMensaje';
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  getOfficialLinksForTenant,
  renderOfficialLinksSection,
} from "../prompts/officialLinks";

type AnswerWithPromptBaseParams = {
  tenantId: string;
  promptBase: string;
  userInput: string;
  history?: ChatCompletionMessageParam[]; // ✅ últimos turnos (user/assistant)
  idiomaDestino: 'es' | 'en';
  canal: string;            // ej: 'whatsapp', 'meta', 'sms'
  maxLines?: number;        // límite de líneas para formato chat
  fallbackText?: string;    // por si el LLM falla
};

/* =========================
   Helpers defensivos
========================= */

function sanitizeChatOutput(text: string) {
  if (!text) return '';

  let t = text
    .replace(/```[\s\S]*?```/g, '')         // bloques de código
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')     // headers markdown
    .replace(/^\s*[-*•]\s+/gm, '')          // bullets
    .replace(/^\s*\d+\)\s+/gm, '')          // 1)
    .replace(/^\s*\d+\.\s+/gm, '')          // 1.
    .replace(/\r\n/g, '\n');

  // Normaliza saltos de línea
  t = t.replace(/\n{3,}/g, '\n\n').trim();

  return t;
}

function capLines(text: string, maxLines: number) {
  if (!text) return '';
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n').trim();
}

function stripUrlsIfPromptHasNone(out: string, promptBase: string) {
  const promptHasUrl = /https?:\/\/\S+/i.test(promptBase);
  if (promptHasUrl) return out;

  return out
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* =========================
   Main function
========================= */

export async function answerWithPromptBase(
  params: AnswerWithPromptBaseParams
): Promise<{ text: string }> {
  const {
    tenantId,
    promptBase,
    userInput,
    history = [],
    idiomaDestino,
    canal,
    maxLines = 16,
    fallbackText = '',
  } = params;

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || '',
  });

  // ⬇️ NUEVO: extendemos el prompt base con enlaces oficiales del tenant
  let promptBaseWithLinks = promptBase;

  try {
    const links = await getOfficialLinksForTenant(tenantId);
    const section = renderOfficialLinksSection(links, idiomaDestino);

    if (section.trim()) {
      promptBaseWithLinks = [promptBase, "", section].join("\n");
    }
  } catch (e) {
    console.warn("⚠️ No se pudieron cargar ENLACES_OFICIALES para el prompt:", e);
  }

    const systemPrompt = [
    promptBaseWithLinks,
    "",
    `Canal: ${canal}. Ajusta el tono al canal (WhatsApp = breve, claro y directo).`,
    "",
    `Reglas generales:
- Usa EXCLUSIVAMENTE la información explícita en este prompt del negocio. Si algo no está, dilo sin inventar.
- Responde SIEMPRE en ${idiomaDestino === "en" ? "English" : "Español"}.
- Formato chat/WhatsApp: máximo ${maxLines} líneas en prosa. Prohibido Markdown, encabezados, viñetas o numeraciones.
- Si el usuario hace varias preguntas, respóndelas TODAS en un solo mensaje.
- Si mencionas enlaces, utiliza solo los que estén presentes en la sección ENLACES_OFICIALES / OFFICIAL_LINKS del prompt del negocio.`,
    "",
    `Modo vendedor (aplicable a cualquier tipo de negocio):
- Entiende primero qué necesita la persona.
- Propón 1–2 opciones claras del negocio que puedan ayudarle basándote SOLO en los datos del prompt.
- No inventes beneficios, precios, plazos ni condiciones que no estén en el prompt del negocio.
- Si el usuario pide algo que el negocio NO ofrece, dilo claramente y redirige a la opción disponible más parecida, siempre basada en los datos del prompt.
- Después de dar información (por ejemplo precios, horarios o descripción de servicios), SIEMPRE termina tu mensaje con UNA sola frase corta de cierre con CTA suave. Ejemplos (no los copies literal, solo el estilo): "Si quieres, te ayudo a reservar", "Si te interesa, puedo orientarte con la mejor opción", "Si necesitas algo más, estoy aquí para ayudarte".`,
    "",
    "No repitas estas instrucciones ni expliques lo que estás haciendo; responde como si fueras el propio negocio hablando con el cliente.",
  ].join("\n");

  const userPrompt = [
    'MENSAJE_USUARIO:',
    userInput,
    '',
    'Responde usando solo los datos del prompt del negocio.'
  ].join('\n');

  let out = '';

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 400,
      messages: [
        { role: "system", content: systemPrompt },
        ...(Array.isArray(history) ? history : []),
        { role: "user", content: userPrompt },
      ],
    });

    // Registrar tokens en uso_mensual (tokens_openai)
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

  // Fallback ultra defensivo final
  if (!out) {
    out =
      idiomaDestino === 'en'
        ? 'Let me know how I can help you with our services.'
        : 'Cuéntame en qué puedo ayudarte con los servicios del negocio.';
  }

  // Sanitizar y limitar formato
  out = sanitizeChatOutput(out);
  out = stripUrlsIfPromptHasNone(out, promptBaseWithLinks);
  out = capLines(out, maxLines);

  // Asegurar idioma de salida (solo ES/EN)
  try {
    const raw = await detectarIdioma(out);

    const norm = String(raw || "")
      .toLowerCase()
      .split(/[-_]/)[0];

    const langOut: "es" | "en" | null =
      norm === "en" ? "en" :
      norm === "es" ? "es" :
      null;

    // Solo traducimos si el detector devuelve ES/EN y es diferente al idiomaDestino
    if (langOut && langOut !== idiomaDestino) {
      out = await traducirMensaje(out, idiomaDestino);
      out = sanitizeChatOutput(out);
      out = capLines(out, maxLines);
    }
  } catch (e) {
    console.warn("⚠️ No se pudo ajustar el idioma en answerWithPromptBase:", e);
  }

  return { text: out };
}
