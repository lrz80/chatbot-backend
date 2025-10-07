// backend/src/utils/tidyMultiAnswer.ts

export type TidyOptions = {
  maxLines?: number;
  preferredDomains?: string[];   // se prioriza el 1º dominio encontrado aquí (solo si freezeUrls=false)
  cta?: string;                  // CTA final opcional
  extraHeaderStrips?: RegExp[];  // regex extra para quitar encabezados/ruido
  freezeUrls?: boolean;          // 👈 si true, NO tocar/deduplicar/ordenar/eliminar URLs
};

const DEFAULT_HEADERS = [
  // muletillas coloquiales (al inicio)
  /^\s*(claro|vale|ok)[\s,.:–—-]*\s*/i,
  /^\s*(te\s+(cuento|explico|comento)\s+(rápido|rapidito)?[:\s–—-]*)/i,
  /^\s*(perfecto|genial|buen[ií]simo)[\s,.:–—-]*\s*/i,
  // saludos
  /^\s*(hola|buen[oa]s(?:\s+(d[ií]as|tardes|noches))?|hello|hi|hey)[\s,.:–—-]*\s*/i,
];

// Sólo se usa cuando freezeUrls === false
function pickBestUrl(urls: string[], preferred: string[] = []) {
  if (!urls.length) return '';
  for (const dom of preferred) {
    const hit = urls.find(u => u.includes(dom));
    if (hit) return hit;
  }
  return urls[0];
}

export function tidyMultiAnswer(raw: string, opts: TidyOptions = {}) {
  const {
    maxLines = 6,
    preferredDomains = [],
    cta = '¿Hay algo más en lo que te pueda ayudar?',   // ✅ con tilde
    extraHeaderStrips = [],
    freezeUrls = false,
  } = opts;

  let text = (raw || '').trim();

  // 0) Normaliza saltos grandes primero
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  // 1) limpiar encabezados / frases de relleno
  for (const rx of [...DEFAULT_HEADERS, ...extraHeaderStrips]) {
    text = text.replace(rx, '').trim();
  }

  // 2) Manejo de URLs
  let finalUrl = '';
  if (!freezeUrls) {
    // a) Tomar todas las URLs
    const urls = Array.from(text.matchAll(/https?:\/\/\S+/g)).map(m => m[0]);

    // b) Elegir 1 “mejor” si hay varias
    finalUrl = pickBestUrl(urls, preferredDomains);

    // c) Quitar TODAS las URLs del cuerpo (se reinsertará 1)
    text = text.replace(/\s*https?:\/\/\S+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  } else {
    // 👉 freezeUrls=true: NO tocamos URLs
    // (no dedupe, no selección, no remoción)
  }

  // 3) Normalizar saltos y limitar líneas
  text = text
    .replace(/[ \t]*\n[ \t]*/g, '\n') // recorta espacios en saltos
    .trim();

  const lines = text.split('\n').filter(Boolean);
  text = lines.slice(0, maxLines).join('\n').trim();

  // 4) Construir salida
  //    - Si freezeUrls=false y finalUrl existe, lo agregamos en su propia línea.
  //    - Si freezeUrls=true, NO tocamos las URLs que ya estén en el cuerpo.
  let out = text;
  if (!freezeUrls && finalUrl) {
    out = `${out}\n\n${finalUrl}`.trim();
  }

  if (cta && cta.trim()) {
    // añade CTA en nueva línea
    out = `${out}\n\n${cta}`.trim();
  }

  return out;
}
