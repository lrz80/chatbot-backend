// backend/src/utils/tidyMultiAnswer.ts
export type TidyOptions = {
  maxLines?: number;
  preferredDomains?: string[];      // se prioriza el 1º dominio encontrado aquí
  cta?: string;                     // CTA final opcional
  extraHeaderStrips?: RegExp[];     // regex extra para quitar encabezados/ruido
};

const DEFAULT_HEADERS = [
  // muletillas coloquiales (al inicio)
  /^\s*(claro|vale|ok)[\s,.:–—-]*\s*/i,
  /^\s*(te\s+(cuento|explico|comento)\s+(rápido|rapidito)?[:\s–—-]*)/i,
  /^\s*(perfecto|genial|buen[ií]simo)[\s,.:–—-]*\s*/i,
  // saludos
  /^\s*(hola|buen[oa]s(?:\s+(d[ií]as|tardes|noches))?|hello|hi|hey)[\s,.:–—-]*\s*/i,
];

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
    // ✅ CTA “segura” (no promete agendar):
    cta = '¿Quieres que te envíe el enlace oficial para ver horarios/precios o resolver otra duda?',
    extraHeaderStrips = [],
  } = opts;

  let text = (raw || '').trim();

  // 1) tomar URLs y elegir 1
  const urls = Array.from(text.matchAll(/https?:\/\/\S+/g)).map(m => m[0]);
  const bestUrl = pickBestUrl(urls, preferredDomains);

  // 2) limpiar encabezados / frases de relleno
  for (const rx of [...DEFAULT_HEADERS, ...extraHeaderStrips]) {
    text = text.replace(rx, '').trim();
  }

  // 3) quitar TODAS las URLs del cuerpo (ya reinsertaremos 1)
  text = text.replace(/\s*https?:\/\/\S+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();

  // 4) normalizar saltos y limitar líneas
  text = text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]*\n[ \t]*/g, '\n')   // recorta espacios en saltos
    .trim();

  const lines = text.split('\n').filter(Boolean);
  text = lines.slice(0, maxLines).join('\n').trim();

  // 5) construir salida con 1 link (si existe) + CTA
  const linkLine = bestUrl ? `\n${bestUrl}` : '';
  return `${text}${linkLine ? `\n${linkLine}` : ''}\n${cta}`.trim();
}
