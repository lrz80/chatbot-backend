// backend/src/lib/intentSlug.ts

// Palabras vacías comunes para limpiar texto
const STOP_WORDS = new Set<string>([
  'que','como','cuanto','cuántos','cuanto','cuando','donde','de','la','el','los','las','y','o','a','en','por','para','un','una',
  'tienen','hay','puedo','si','se','es','son','con','del','al','clase','clases','spin','spinning','cycling'
]);

export function normalizeTxt(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g,' ')
    .trim();
}

export function topKeywords(text: string, k = 3): string {
  const words = normalizeTxt(text)
    .split(/[^a-z0-9]+/)
    .filter(w => w && !STOP_WORDS.has(w) && w.length > 2);
  const freq: Record<string, number> = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  return Object
    .entries(freq)
    .sort((a,b)=>b[1]-a[1])
    .slice(0,k)
    .map(([w])=>w)
    .join('_');
}

// Canonicaliza alias de intenciones a un único slug
export function normalizeIntentAlias(intent: string): string {
  const map: Record<string, string> = {
    // alias históricos o sinónimos → canónico
    'clases_virtuales': 'clases_online',
    'duda__clases_virtuales': 'duda__clases_online',
    // si quieres cubrir otros posibles
    'clase_virtual': 'clases_online',
    'clase_online': 'clases_online',
  };
  return map[intent] ?? intent;
}

// Convierte "duda" genérica en sub-intención específica
export function buildDudaSlug(userText: string): string {
  const t = normalizeTxt(userText);

  if (/(online|virtual(es)?|en\s*linea|en\s*línea|zoom|teams|meet|stream)/i.test(t)) return 'duda__clases_online';
  if (/(duracion|dura|tiempo.*clase|minutos)/i.test(t)) return 'duda__duracion_clase';
  if (/(guarderia|guardería|kids|niñ[oa]s?\s*cuidado|daycare)/i.test(t)) return 'duda__guarderia';
  if (/(menor(es)?|edad\s*minima|minima\s*edad|under\s*\d+)/i.test(t)) return 'duda__menores';
  if (/(embarazad[ao]|embarazo|pregnan)/i.test(t)) return 'duda__embarazo';
  if (/(rodilla|rodillas|knee|knees)/i.test(t)) return 'duda__rodillas';

  const kw = topKeywords(t, 3) || 'general';
  return `duda__${kw}`;
}

// Decide si es una intención “directa” (las tuyas + cualquier duda__*)
export function isDirectIntent(intent: string, baseSet: Set<string>): boolean {
  return baseSet.has(intent) || intent.startsWith('duda__');
}
