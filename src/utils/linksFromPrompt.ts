// utils/linksFromPrompt.ts
export type LinkMap = Record<string, string>;

/** Normaliza: elimina \r y colapsa espacios */
function clean(s = '') { return s.replace(/\r/g, ''); }

/** Extrae pares de tipo CLAVE_URL: https... desde el prompt.  */
export function linksFromPrompt(promptBase: string): LinkMap {
  const text = clean(promptBase);
  const map: LinkMap = {};

  // — (A) Limita primero al bloque ENLACES_OFICIALES si existe
  const official = text.match(/ENLACES?_OFICIALES[\s\S]*?(?:\n{2,}|$)/i)?.[0] || text;

  // — (B) Formato "CLAVE_URL: http..."
  const reKV = /^\s*([A-Z0-9_]+(?:_URL|_LINK))\s*:\s*(https?:\/\/\S+)\s*$/gim;
  for (const m of official.matchAll(reKV)) map[m[1].toUpperCase()] = m[2].trim();

  // — (C) Formato tabla markdown: | CLAVE_URL | http... |
  const reTbl = /\|\s*([A-Z0-9_]+(?:_URL|_LINK))\s*\|\s*(https?:\/\/[^|\s]+)\s*\|/gim;
  for (const m of official.matchAll(reTbl)) map[m[1].toUpperCase()] = m[2].trim();

  return map;
}

/** Resuelve una URL dando prioridad a la variante por canal.
 *  Ej.: para canal 'whatsapp' y clave 'PRECIOS_URL', primero busca 'WHATSAPP_PRECIOS_URL',
 *  luego 'PRECIOS_URL'. */
export function resolveChannelUrl(links: LinkMap, canal: string, keys: string[]): string | null {
  const L = Object.fromEntries(Object.entries(links).map(([k, v]) => [k.toUpperCase(), v]));
  const ch = (canal || '').toUpperCase(); // WHATSAPP | META | VOZ | PREVIEW, etc.

  for (const baseKey of keys) {
    const k = baseKey.toUpperCase();
    const chKey = `${ch}_${k}`;
    if (L[chKey]) return L[chKey];
    if (L[k]) return L[k];
  }
  return null;
}

/** Mapa explícito intención -> posibles claves de link (sin heurísticas) */
export const WANTED_KEYS_BY_INTENT: Record<string, string[]> = {
  // funnel “descubrir”
  interes_clases: ['CLASES_URL','SERVICIOS_URL','INFO_URL'],
  info_general:   ['INFO_URL','HOME_URL','LANDING_URL'],

  // precios/planes
  precio:         ['PRECIOS_URL','PRICING_URL','PLANES_URL','MEMBERSHIP_URL','MEMBERSHIPS_URL'],

  // horarios/agenda/compra
  horario:        ['HORARIOS_URL','SCHEDULE_URL'],
  reservar:       ['RESERVA_URL','BOOK_URL','BOOKING_URL','AGENDA_URL'],
  comprar:        ['COMPRAR_URL','BUY_URL','CHECKOUT_URL','MEMBERSHIPS_URL'],

  // ubicación
  ubicacion:      ['UBICACION_URL','LOCATION_URL','ADDRESS_URL','MAPS_URL','DIRECCIONES_URL'],

  // clases online
  clases_online:  ['CLASES_ONLINE_URL','VIRTUAL_URL'],

  // ——— NUEVO: SOPORTE / CONTACTO ———
  soporte:        ['SOPORTE_URL','SUPPORT_URL','AYUDA_URL','HELP_URL','CONTACTO_URL','CONTACT_URL','WHATSAPP_URL','INSTAGRAM_URL','FACEBOOK_URL','EMAIL_URL'],

  // extras (por si los pides por intención en el futuro)
  politicas:      ['POLITICAS_URL','POLICIES_URL','TERMS_URL','PRIVACIDAD_URL','PRIVACY_URL'],
  faq:            ['FAQ_URL','PREGUNTAS_URL'],
  giftcards:      ['GIFTCARD_URL','GIFTCARDS_URL'],
};

/** Dado el set de intenciones detectadas, elige el link exacto desde el prompt (multicanal). */
export function pickUrlForIntents(links: LinkMap, canal: string, intents: string[]): string | null {
  // 1) Recorre las intenciones en orden y busca su primera clave válida por canal
  for (const intent of intents) {
    const keys = WANTED_KEYS_BY_INTENT[intent] || [];
    const url = resolveChannelUrl(links, canal, keys);
    if (url) return url;
  }
  // 2) Fallbacks suaves y cross-tenant
  return resolveChannelUrl(links, canal, ['HOME_URL', 'LANDING_URL']) || null;
}
