// backend/src/utils/intent.ts
const GENERICAS = new Set(['duda', 'consulta', 'pregunta']);

function slug(p: string) {
  return (p || 'faq')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // sin acentos
    .replace(/[^a-z0-9]+/g, '_')                     // no alfanum
    .replace(/^_+|_+$/g, '')                         // bordes
    .slice(0, 40);
}

export function intencionSegura(base: string, pregunta: string) {
  const b = (base || '').trim().toLowerCase();
  if (!GENERICAS.has(b)) return b;
  return `${b}_${slug(pregunta)}`; // ej: "duda_tienen_clases_online"
}
