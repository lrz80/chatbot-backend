// src/lib/recoPrincipiantes/detectores.ts
export const stripDiacritics = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

export const norm = (s: string) => stripDiacritics(s.toLowerCase().trim());

export function stripLeadingGreeting(t: string) {
  const re = /^(hola|hello|hi|hey|buenos dias|buenas tardes|buenas noches)[\s,!.:-]*\b/i;
  return t.replace(re, '').trim();
}

/** Detecta preguntas tipo "¿cuál recomiendas?" en ES/EN */
export function esPreguntaRecomendacion(raw: string) {
  const t = norm(stripLeadingGreeting(raw));
  // ES
  const es =
    /\bcual(es)?\b.*\brecom/i.test(t) ||
    /\bque\b.*\brecom/i.test(t) ||
    /\brecomendaci(o|ó)n\b/.test(t) ||
    /\bpara empezar\b/.test(t) ||
    /\bprincipiante(s)?\b/.test(t);
  // EN
  const en =
    /\bwhich\b.*\brecommend/i.test(t) ||
    /\bwhat\b.*\brecommend/i.test(t) ||
    /\brecommendation\b/.test(t) ||
    /\bbeginner\b.*\brecommend/i.test(t);
  return es || en;
}
