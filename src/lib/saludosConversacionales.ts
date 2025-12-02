// backend/src/lib/saludosConversacionales.ts

export type IdiomaBasico = 'es' | 'en';

// Saludo muy corto tipo "hola", "hello", "buenas", etc.
export const saludoPuroRegex =
  /^\s*(hola|hello|hi|hey|buenas(?:\s+(tardes|noches|dias|días))?|buenos\s+(dias|días))\s*$/i;

// Small-talk tipo "hola como estas", "hello how are you", etc.
export const smallTalkRegex =
  /^\s*(hola+[,!.\s]*(como|cómo)\s+estas?|hello[,!.\s]*how\s+are\s+you\??|hi[,!.\s]*how\s+are\s+you\??|how\s+are\s+you\??)\s*$/i;

export const graciasPuroRegex =
  /^\s*(gracias|muchas\s+gracias|thank\s*you|thanks|thx|ty)\s*$/i;

// Saludo normal para cuando el mensaje es solo "hola", "hello", etc.
export function buildSaludoConversacional(tenant: any, idioma: IdiomaBasico): string {
  const nombreNegocio =
    (tenant?.nombre_negocio || tenant?.name || '').trim() || 'nuestro negocio';

  if (idioma === 'en') {
    return `Hi 👋 I’m Amy, welcome to ${nombreNegocio}. How can I help you today?`;
  }

  return `Hola 👋 Soy Amy, bienvenida/o a ${nombreNegocio}. ¿En qué puedo ayudarte hoy?`;
}

// Saludo cuando el usuario hace small-talk tipo "hello how are you?"
export function buildSaludoSmallTalk(tenant: any, idioma: IdiomaBasico): string {
  const nombreNegocio =
    (tenant?.nombre_negocio || tenant?.name || '').trim() || 'nuestro negocio';

  if (idioma === 'en') {
    return `Hi 👋 I’m Amy, welcome to ${nombreNegocio}. I’m doing great, thanks for asking. What can I help you with today?`;
  }

  return `Hola 👋 Soy Amy, bienvenida/o a ${nombreNegocio}. Estoy muy bien, gracias por preguntar. ¿En qué te puedo ayudar hoy?`;
}

export function buildGraciasRespuesta(idioma: IdiomaBasico): string {
  if (idioma === 'en') {
    return "You're welcome! If you need anything else, just let me know.";
  }

  return "¡Con gusto! Si necesitas algo más, solo dime.";
}