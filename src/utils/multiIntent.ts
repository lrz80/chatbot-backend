// utils/multiIntent.ts
import pool from '../lib/db';
import { Canal } from '../lib/detectarIntencion';
import { normalizeIntentAlias } from '../lib/intentSlug';
import { traducirMensaje } from '../lib/traducirMensaje';
import { getFaqByIntent } from './getFaqByIntent';
import { fetchFaqPrecio } from '../lib/faq/fetchFaqPrecio';
import OpenAI from 'openai';
import { linksFromPrompt, pickUrlForIntents } from './linksFromPrompt';

type TopIntent = { intent: string; score: number };

const CANDIDATES = [
  'interes_clases','info_general','servicios',
  'precio','horario','ubicacion','reservar','comprar','clases_online',
  // 👇 nuevas
  'soporte','faq','politicas','giftcards'
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

  // 👇 soporte / contacto
  if (/\b(soporte|support|ayuda|help|contact(o)?|customer\s*service|n[uú]mero|whatsapp|instagram|facebook|email)\b/i.test(s)) add('soporte', 2);

  // 👇 extras
  if (/\b(faq|preguntas\s*frecuentes)\b/i.test(s)) add('faq', 1);
  if (/\b(pol[ií]tica(s)?|policies|terms|privacidad|privacy)\b/i.test(s)) add('politicas', 1);
  if (/\b(gift\s*card(s)?|giftcards?)\b/i.test(s)) add('giftcards', 1);

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
  if (!top?.length) return null;

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

  // Construye HECHOS por intención
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

    if (fact) parts.push(fact.trim());
    else missing.push(intent);
  }

  // Prepara LLM
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
  const systemPrompt = [
    promptBase,
    '',
    `Reglas:
    - Responde SIEMPRE en ${idiomaDestino === 'en' ? 'English' : 'Español'}.
    - WhatsApp: máx. ~6 líneas en prosa. Sin viñetas/markdown.
    - Usa SOLO la información del prompt.
    - SI HAY PRECIOS EN EL PROMPT/HECHOS, MENCIONA al menos 1-3 planes con su monto (resumen corto).
    - Si NO hay precios en el prompt/HECHOS, dilo explícitamente y ofrece el siguiente paso.
    - Si el usuario preguntó varias cosas, cúbrelas en UN solo mensaje.`,
  ].join('\n');

  let outText: string | null = null;

  // Caso A: hay algunos HECHOS → compacta con LLM
  if (parts.length) {
    const hechos = parts.join('\n\n');
    const userMsg = [
      `MENSAJE_USUARIO:\n${userText}`,
      '',
      `HECHOS (usa esto como única fuente):\n${hechos}`,
      missing.length ? `\nNOTA: No hay datos oficiales para: ${missing.join(', ')}.` : '',
      `\nINSTRUCCIÓN: Si en los HECHOS aparecen montos ($, USD), incluye un resumen de precios en texto plano.`
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
      const out = completion.choices[0]?.message?.content?.trim() || hechos;
      try {
        const t = await traducirMensaje(out, idiomaDestino);
        outText = (t || out).trim();
      } catch {
        outText = out;
      }
    } catch {
      // si LLM falla, usa HECHOS unidos
      try {
        const joined = parts.join('\n\n');
        const t = await traducirMensaje(joined, idiomaDestino);
        outText = (t || joined).trim();
      } catch {
        outText = parts.join('\n\n').trim();
      }
    }
  }

  // Caso B: no hubo HECHOS → responde directo con LLM usando prompt
  if (!outText) {
    try {
      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0.2,
        max_tokens: 400,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `MENSAJE_USUARIO:\n${userText}\n\nResponde solo con lo que está en el prompt. Si el prompt contiene montos/precios, dilo de forma breve; si no, indícalo y ofrece el mejor siguiente paso (link o agendar).` }
        ],
      });
      outText = completion.choices[0]?.message?.content?.trim() || null;
    } catch {
      outText = null;
    }
  }

  if (!outText) return null;

  // === MULTICANAL + MULTINEGOCIO ===
  // Elige el enlace exacto desde el prompt para las intenciones detectadas (sin heurísticas)
  const linkMap = linksFromPrompt(promptBase);
  const chosenUrl = pickUrlForIntents(linkMap, canal, intentsOrdered);

  if (chosenUrl && !outText.includes(chosenUrl)) {
    outText = `${outText}\n\n${chosenUrl}`;
  }

  return outText.trim();
}
