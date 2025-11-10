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
  const raw = (intent || '').toLowerCase().trim();
  if (!raw) return raw;

  // Si viene como duda__*, normalizamos el sufijo y lo reensamblamos
  const isDuda = raw.startsWith('duda__');
  const base = isDuda ? raw.slice(6) : raw;

  // Mapa de alias → canónico
  const map: Record<string, string> = {
    // === Precio ===
    'precio': 'precio',
    'precios': 'precio',
    'price': 'precio',
    'prices': 'precio',
    'tarifa': 'precio',
    'tarifas': 'precio',
    'fee': 'precio',
    'fees': 'precio',
    'costo': 'precio',
    'costos': 'precio',
    'cuota': 'precio',
    'mensualidad': 'precio',
    'membership': 'precio',

    // === Horario ===
    'horario': 'horario',
    'horarios': 'horario',
    'schedule': 'horario',
    'hours': 'horario',
    'opening_hours': 'horario',

    // === Ubicación ===
    'ubicacion': 'ubicacion',
    'ubicación': 'ubicacion',
    'direccion': 'ubicacion',
    'dirección': 'ubicacion',
    'address': 'ubicacion',
    'location': 'ubicacion',
    'donde': 'ubicacion',
    'dónde': 'ubicacion',
    'where': 'ubicacion',

    // === Reservar / Agendar ===
    'reservar': 'reservar',
    'reserva': 'reservar',
    'reservas': 'reservar',
    'agendar': 'reservar',
    'agenda': 'reservar',
    'book': 'reservar',
    'booking': 'reservar',
    'schedule_class': 'reservar',

    // === Comprar / Pagar ===
    'comprar': 'comprar',
    'compra': 'comprar',
    'compras': 'comprar',
    'pagar': 'comprar',
    'payment': 'comprar',
    'pay': 'comprar',
    'buy': 'comprar',
    'purchase': 'comprar',

    // === Confirmar ===
    'confirmar': 'confirmar',
    'confirm': 'confirmar',
    'confirmation': 'confirmar',

    // === Interés / Info ===
    'interes_clases': 'interes_clases',
    'interés_clases': 'interes_clases',
    'interes': 'interes_clases',
    'interés': 'interes_clases',
    'interesado': 'interes_clases',
    'interesados': 'interes_clases',
    'info': 'interes_clases',
    'informacion': 'interes_clases',
    'información': 'interes_clases',
    'pedir_info': 'interes_clases',

    // === Clases online / virtuales ===
    'clases_online': 'clases_online',
    'clases_virtuales': 'clases_online',
    'clase_virtual': 'clases_online',
    'clase_online': 'clases_online',
    'online': 'clases_online',
    'virtual': 'clases_online',
    'virtuales': 'clases_online',
    'en_linea': 'clases_online',
    'en_linea_clases': 'clases_online',
  };

  // Normaliza el “base” con el mapa
  const normalizedBase = map[base] ?? base;

  // Re-armar si era duda__*
  if (isDuda) {
    // También normaliza dudas con alias/plurales: p.ej. duda__precios → duda__precio
    return `duda__${map[normalizedBase] ?? normalizedBase}`;
  }

  return normalizedBase;
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

// ✅ Slug final: usa tu mapa de alias + slugify
export function intentToSlug(intent: string = ""): string {
  const canonical = normalizeIntentAlias(intent || "");
  return canonical
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "") // sin acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")                       // todo lo no [a-z0-9] -> "-"
    .replace(/(^-|-$)/g, "");                          // sin guiones en bordes
}
