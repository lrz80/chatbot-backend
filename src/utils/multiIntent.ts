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
  // 1) detectar top intents
  const intents = await detectTopIntents(userText, tenantId, canal, 3);

  // 2) traer FAQs por intención
  const chunksByIntent: Record<string,string> = {};
  for (const it of intents) {
    const ans = await fetchAnswer(tenantId, canal, it.intent);
    if (ans) chunksByIntent[it.intent] = ans.trim();
  }
  if (!Object.keys(chunksByIntent).length) return null;

  // 3) helpers de formato
  const clean = (t:string) =>
    (t || '')
      // fuera encabezados/viñetas y dobles espacios
      .replace(/^[-*•]\s*/gm,'')
      .replace(/#{1,6}\s*/g,'')
      .replace(/\r/g,'')
      .replace(/\n{3,}/g,'\n\n')
      .trim();

  const firstSentence = (t:string, max=180) => {
    const s = t.split(/(?<=\.)\s|\n/)[0]?.trim() || t.trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  };

  const pickLink = (parts:string[]) => {
    const urls = parts.flatMap(p => [...p.matchAll(/https?:\/\/\S+/gi)].map(m=>m[0]));
    // prioriza glofox / booking / membership
    const preferred = urls.find(u => /glofox|book|reserv|membership|buy/i.test(u));
    return preferred || urls[0] || null;
  };

  // 4) prioriza qué meter (precio + info/servicios)
  const txtPrecio   = clean(chunksByIntent['precio'] || '');
  const txtInfo     = clean(chunksByIntent['interes_clases'] || chunksByIntent['pedir_info'] || '');
  const txtHorario  = clean(chunksByIntent['horario'] || '');
  const txtUbic     = clean(chunksByIntent['ubicacion'] || '');

  // arma líneas cortas
  const lineIntro   = idiomaDestino === 'en'
    ? 'Sure — quick summary:'
    : 'Claro — te cuento rapidito:';

  const lineInfo = txtInfo
    ? (idiomaDestino === 'en'
        ? firstSentence(txtInfo, 220)
        : firstSentence(txtInfo, 220))
    : '';

  const linePrecio = txtPrecio
    ? (idiomaDestino === 'en'
        ? 'Prices: ' + firstSentence(txtPrecio.replace(/\n/g,' '), 220)
        : 'Precios: ' + firstSentence(txtPrecio.replace(/\n/g,' '), 220))
    : '';

  const lineHorario = txtHorario
    ? (idiomaDestino === 'en'
        ? 'Schedule: ' + firstSentence(txtHorario.replace(/\n/g,' '), 180)
        : 'Horarios: ' + firstSentence(txtHorario.replace(/\n/g,' '), 180))
    : '';

  const lineUbic = txtUbic
    ? (idiomaDestino === 'en'
        ? 'Location: ' + firstSentence(txtUbic.replace(/\n/g,' '), 130)
        : 'Ubicación: ' + firstSentence(txtUbic.replace(/\n/g,' '), 130))
    : '';

  const ctaLink = pickLink([txtPrecio, txtInfo, txtHorario, txtUbic]);
  const lineCTA = ctaLink
    ? (idiomaDestino === 'en'
        ? `Book or see more here: ${ctaLink}`
        : `Reserva o mira más aquí: ${ctaLink}`)
    : '';

  // 5) compón en 4–6 líneas máx (sin bullets/markdown)
  const lines = [lineIntro, lineInfo, linePrecio, lineHorario || lineUbic, lineCTA]
    .filter(Boolean);

  let out = lines.join('\n').slice(0, 950); // margen WhatsApp

  // 6) asegurar idioma (por si las FAQs estaban en otro)
  try {
    const langOut = await detectarIdioma(out);
    if (langOut && langOut !== 'zxx' && langOut !== idiomaDestino) {
      out = await traducirMensaje(out, idiomaDestino);
    }
  } catch {}

  return out;
}
