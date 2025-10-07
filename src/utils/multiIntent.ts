// utils/multiIntent.ts
import pool from '../lib/db';
import { Canal } from '../lib/detectarIntencion';
import { normalizeIntentAlias } from '../lib/intentSlug';
import { traducirMensaje } from '../lib/traducirMensaje';
import { getFaqByIntent } from './getFaqByIntent';
import { fetchFaqPrecio } from '../lib/faq/fetchFaqPrecio';
import OpenAI from 'openai';

type TopIntent = { intent: string; score: number };

const CANDIDATES = [
  'interes_clases','info_general','servicios','precio','horario','ubicacion','reservar','comprar','clases_online'
];

// Heurística sencilla por keywords (si no usas embeddings aquí)
function keywordVote(txt: string) {
  const s = (txt || '').toLowerCase();
  const votes: Record<string, number> = {};
  const add = (k: string, w = 1) => (votes[k] = (votes[k] || 0) + w);

  if (/\b(info|información|services?|servicios?|clases?)\b/i.test(s)) add('interes_clases', 2);
  if (/\b(precio|precios|cost(o|os)|tarifa(s)?|fee|fees|price|prices|rate|rates|cu[oó]ta|mensualidad|membership|charge|tuition)\b/i.test(s)) add('precio', 2);
  if (/\b(horario|schedule|schedules|available times?)\b/i.test(s)) add('horario', 1);
  if (/\b(ubicaci[oó]n|address|location|d[oó]nde)\b/i.test(s)) add('ubicacion', 1);
  if (/\b(reserv(ar|a)|agendar|book|booking)\b/i.test(s)) add('reservar', 1);
  if (/\b(compr(ar|a)|buy|checkout)\b/i.test(s)) add('comprar', 1);
  if (/\b(online|virtual)\b/i.test(s)) add('clases_online', 1);

  const arr = Object.entries(votes).map(([intent, score]) => ({ intent, score }));
  return arr.sort((a, b) => b.score - a.score);
}

export async function detectTopIntents(
  userText: string,
  _tenantId: string,
  _canal: Canal,
  k = 3
): Promise<TopIntent[]> {
  const ranked = keywordVote(userText).slice(0, k);
  return ranked.map(r => ({ intent: normalizeIntentAlias(r.intent), score: r.score }));
}

export async function answerMultiIntent(opts: {
  tenantId: string;
  canal: Canal;
  userText: string;
  idiomaDestino: 'es'|'en';
  /** pásame el prompt base ya resuelto por canal/tenant/idioma */
  promptBase: string;
}): Promise<string | null> {
  const { tenantId, canal, userText, idiomaDestino, promptBase } = opts;

  const top = await detectTopIntents(userText, tenantId, canal, 4);
  if (!top?.length) {
    // ❗️Sin señales: deja que el pipeline normal maneje
    return null;
  }

  const hasInfo   = top.some(t => ['interes_clases','info_general','servicios'].includes(t.intent));
  const hasPrecio = top.some(t => t.intent === 'precio');

  // Orden sugerido (info → precio → demás)
  const intentsOrdered = [
    ...(hasInfo ? ['interes_clases'] : []),
    ...(hasPrecio ? ['precio'] : []),
    ...top.map(t => t.intent).filter(i => !['interes_clases','precio'].includes(i))
  ].filter((v, i, a) => a.indexOf(v) === i);

  const parts: string[] = [];
  const missing: string[] = [];

  for (const intent of intentsOrdered) {
    let fact: string | null = null;

    if (intent === 'precio') {
      fact = await fetchFaqPrecio(tenantId, canal);
      if (!fact) {
        const hitPrecio = await getFaqByIntent(tenantId, canal, 'precio');
        fact = hitPrecio?.respuesta || null;
      }
    } else {
      const hit = await getFaqByIntent(tenantId, canal, intent);
      fact = hit?.respuesta || null;
    }

    if (fact) {
      parts.push(fact.trim());
    } else {
      missing.push(intent);
    }
  }

  // ⚠️ Si no hay NINGÚN fact, igual contesta usando el promptBase (LLM),
  // siendo transparente con la falta de datos específicos.
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

  const systemPrompt = [
    promptBase,
    '',
    `Reglas:
    - Responde SIEMPRE en ${idiomaDestino === 'en' ? 'English' : 'Español'}.
    - WhatsApp: máx. ~6 líneas en prosa. Sin viñetas/markdown.
    - Usa SOLO la información del prompt. Si faltan datos (p.ej. precios), dilo explícitamente y ofrece el siguiente paso (enlace oficial/CTA).
    - Si el usuario preguntó varias cosas, cúbrelas en UN solo mensaje.`,
  ].join('\n');

  // Caso A: hay algunos facts → pásalos como HECHOS al LLM para que los compacte;
  // menciona honestamente lo que falte (missing)
  if (parts.length) {
    const hechos = parts.join('\n\n');
    const userMsg = [
      `MENSAJE_USUARIO:\n${userText}`,
      '',
      `HECHOS (usa esto como única fuente):\n${hechos}`,
      missing.length
        ? `\nNOTA: No hay datos oficiales para: ${missing.join(', ')}. Si el usuario pidió eso, indícalo y ofrece el enlace/CTA más útil.`
        : ''
    ].join('\n');

    try {
      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0.2,
        max_tokens: 400,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userMsg }
        ],
      });

      const out = completion.choices[0]?.message?.content?.trim();
      if (out) {
        try {
          const langOut = idiomaDestino; // ya pedimos idioma en systemPrompt
          const t = await traducirMensaje(out, langOut);
          return (t || out).trim();
        } catch { return out; }
      }
    } catch {
      // si LLM falla, devuelve facts unidos
      try {
        const joined = parts.join('\n\n');
        const t = await traducirMensaje(joined, idiomaDestino);
        return (t || joined).trim();
      } catch {
        return parts.join('\n\n').trim();
      }
    }
  }

  // Caso B: no hubo facts → responde directamente con LLM usando promptBase
  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 400,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: `MENSAJE_USUARIO:\n${userText}\n\nResponde solo con lo que está en el prompt. Si faltan precios u horarios oficiales, dilo y ofrece el mejor siguiente paso (link o agendar).` }
      ],
    });
    const out = completion.choices[0]?.message?.content?.trim();
    return out || null;
  } catch {
    return null;
  }
}
