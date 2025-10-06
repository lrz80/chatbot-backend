// backend/src/utils/multiIntent.ts
import pool from '../lib/db';
import { detectarIntencion } from '../lib/detectarIntencion';
import { normalizeIntentAlias } from '../lib/intentSlug';
import { traducirMensaje } from '../lib/traducirMensaje';
import { detectarIdioma } from '../lib/detectarIdioma';
import { getFaqByIntent } from './getFaqByIntent';
import { fetchFaqPrecio } from '../lib/faq/fetchFaqPrecio';
import type { Canal } from '../lib/detectarIntencion';

type Detected = { intent: string; score: number };

// ——— utilidades de normalización ———
const stripDiacritics = (s: string) =>
  (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const norm = (s: string) => stripDiacritics((s || '').toLowerCase().trim());

// Saludos al inicio (hola/hi/hey/buenos días/tardes/noches) → fuera
const STRIP_GREET = (t: string) =>
  (t || '')
    .replace(/^\s*(hola+|hello+|hi+|hey+|buen[oa]s(?:\s+(d[ií]as|tardes|noches))?)[\s!.,:-]*/i, '')
    .trim();

/**
 * Detecta hasta N intenciones “top” combinando:
 * - una pasada por `detectarIntencion` (si cae a heurísticas, 0 tokens; si usa fallback LLM, consumirá tokens)
 * - reglas rápidas por palabras clave
 */
export async function detectTopIntents(
  text: string,
  tenantId: string,
  canal: Canal,
  maxIntents = 3,
  threshold = 0.55
): Promise<Detected[]> {
  const cleaned = STRIP_GREET(text);
  console.log('[MULTI] cleaned=', cleaned); // 👈 NUEVO
  const lc = norm(cleaned);

  const bag: Detected[] = [];

  // 1) clasificador general (puede usar fallback LLM)
  try {
    const { intencion } = await detectarIntencion(cleaned, tenantId, canal);
    if (intencion) {
      bag.push({ intent: normalizeIntentAlias(intencion.toLowerCase()), score: 1 });
    }
  } catch {
    // si falla, seguimos con heurísticas
  }

    // 2) heurísticas rápidas (0 tokens)
  if (/\b(precio|precios|costo|costos|tarifa|tarifas|fee|fees|price|prices|cost)\b/i.test(lc)) {
    bag.push({ intent: 'precio', score: 0.95 });
  }
  if (/\b(info|informacion|informaci[óo]n|servicio|servicios|clase|clases)\b/i.test(lc)) {
    bag.push({ intent: 'interes_clases', score: 0.8 });
  }
  if (/\b(horario|horarios|hours|hour|schedule|time|times)\b/i.test(lc)) {
    bag.push({ intent: 'horario', score: 0.8 });
  }
  if (/\b(ubicacion|ubicaci[óo]n|donde|dónde|address|direcci[óo]n|location)\b/i.test(lc)) {
    bag.push({ intent: 'ubicacion', score: 0.7 });
  }

  // 3) ordenar, normalizar alias, deduplicar y filtrar por umbral
  const seen = new Set<string>();
  const out = bag
    .sort((a, b) => b.score - a.score)
    .filter((x) => {
      x.intent = normalizeIntentAlias(x.intent);
      if (seen.has(x.intent)) return false;
      seen.add(x.intent);
      return x.score >= threshold;
    })
    .slice(0, maxIntents);

  console.log('[MULTI] intents=', out); // 👈 NUEVO
  return out;
}

async function fetchAnswer(tenantId:string, canal: Canal, intent:string): Promise<string|null> {
  const i = intent.toLowerCase();
  if (i === 'precio') return await fetchFaqPrecio(tenantId, canal);
  const hit = await getFaqByIntent(tenantId, canal, i);
  return hit?.respuesta ?? null;
}

/**
 * Responde preguntas con 2–3 intenciones en un mismo mensaje.
 * Regresa `null` si no hay nada que responder (p.ej., sin FAQs cargadas).
 */
export async function answerMultiIntent({
  tenantId, canal, userText, idiomaDestino
}: {
  tenantId: string; canal: Canal; userText: string; idiomaDestino: 'es'|'en';
}) {
  // 1) Detecta top intents
  const rawIntents = await detectTopIntents(userText, tenantId, canal, 3);

  // 2) Re-ordena por prioridad de negocio
  const prio = (i:string) => {
    const x = i.toLowerCase();
    if (x === 'interes_clases') return 1;
    if (x === 'precio')        return 2;
    if (x === 'horario')       return 3;
    if (x === 'ubicacion')     return 4;
    return 9;
  };
  const intents = [...rawIntents]
    .sort((a,b) => prio(a.intent) - prio(b.intent));

  // 3) Trae “hechos” por intención
  const chunksByIntent: Record<string,string> = {};
  for (const it of intents) {
    const ans = await fetchAnswer(tenantId, canal, it.intent);
    if (ans) chunksByIntent[it.intent] = ans.trim();
  }
  if (!Object.keys(chunksByIntent).length) return null;

  // 4) Helpers de formato (prosa breve)
  const clean = (t:string) => (t || '')
    // fuera encabezados/viñetas y dobles espacios
    .replace(/^[\-*•]\s*/gm,'')
    .replace(/#{1,6}\s*/g,'')
    .replace(/\r/g,'')
    .replace(/\n{3,}/g,'\n\n')
    .trim();

  const firstSentence = (t:string, max=180) => {
    const c = clean(t);
    const cut = c.split(/(?<=\.)\s|\n/)[0] || c;
    return cut.length <= max ? cut : (cut.slice(0, max-1).trim() + '…');
  };

  const grabFirstUrl = (t:string) => {
    const m = (t || '').match(/\bhttps?:\/\/[^\s)]+/i);
    return m?.[0] || null;
  };

  // 5) Construir mensaje único (máx. ~6 líneas)
  const intro = idiomaDestino === 'en'
    ? 'Sure — quick overview:'
    : 'Claro — te cuento rapidito:';

  const lines: string[] = [intro];

  if (chunksByIntent['interes_clases']) {
    lines.push(firstSentence(chunksByIntent['interes_clases'], 220));
  }

  if (chunksByIntent['precio']) {
    const p = firstSentence(chunksByIntent['precio'], 220);
    lines.push(idiomaDestino === 'en' ? `Prices: ${p}` : `Precios: ${p}`);
  }

  if (chunksByIntent['horario']) {
    lines.push(firstSentence(chunksByIntent['horario'], 160));
  }

  if (chunksByIntent['ubicacion']) {
    lines.push(firstSentence(chunksByIntent['ubicacion'], 160));
  }

  // 6) Un (1) link relevante si existe
  const urls = [
    grabFirstUrl(chunksByIntent['interes_clases'] || ''),
    grabFirstUrl(chunksByIntent['precio'] || ''),
    grabFirstUrl(chunksByIntent['horario'] || ''),
  ].filter(Boolean) as string[];

  const oneLink = urls[0];
  if (oneLink) {
    lines.push(oneLink);
  }

  // 7) CTA de cierre
  const cta = idiomaDestino === 'en'
    ? 'Want me to book a spot for you?'
    : '¿Quieres que te agende un cupo?';
  lines.push(cta);

  // 8) Limita a 6 líneas y une
  const out = lines.slice(0, 6).join('\n');
  return out;
}
