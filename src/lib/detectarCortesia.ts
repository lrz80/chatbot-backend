function normalizeCourtesy(text: string) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // quitar acentos
    .replace(/[¡!¿?\.,;:]/g, ' ')     // quitar signos
    .replace(/\s+/g, ' ')             // normalizar espacios
    .trim();
}

function tokenize(text: string): string[] {
  return text.split(' ').filter(Boolean);
}

// ===============================
// 🔹 CATÁLOGO UNIVERSAL DE SALUDOS
// ===============================
const GREETING_WORDS = new Set<string>([
  // Español
  'hola', 'holaa', 'holaaa', 'holi', 'holis',
  'buenos', 'buenas', 'buen',
  'dia', 'dias', 'tarde', 'tardes', 'noche', 'noches',
  'saludos',

  // Inglés
  'hello', 'hi', 'hey', 'heyy', 'heyyy',
  'good', 'morning', 'afternoon', 'evening', 'night',
  'greetings',

  // Abreviaturas
  'gm', 'gn',

  // Spanglish / Mixtos
  'goodos', 'goodas', 'gooditas', // por errores comunes
  'buen', 'buenas',

  // Conectores que suelen aparecer en saludos
  'there', 'yo',

  // Emojis comunes escritos
  'wave', 'hand'
]);

// ===============================
// 🔹 CATÁLOGO UNIVERSAL DE GRACIAS
// ===============================
const THANKS_WORDS = new Set<string>([
  // Español
  'gracias', 'graciass', 'graciasss',
  'muchas', 'muchisimas', 'muchisima',
  'mil', 'se', 'agradece',
  'te', 'lo', 'agradezco',
  'muy', 'amable',

  // Inglés
  'thanks', 'thank', 'you', 'thanx', 'thx',
  'appreciate', 'appreciated', 'appreciating',
  'lot', 'so', 'much', 'it',

  // Spanglish
  'graciasthanks', 'thanksgacias'
]);

export function detectarCortesia(text: string): {
  isGreeting: boolean;
  isThanks: boolean;
  normalized: string;
} {
  const normText = normalizeCourtesy(text);
  const tokens = tokenize(normText);

  if (!normText || tokens.length === 0) {
    return { isGreeting: false, isThanks: false, normalized: normText };
  }

  // ✅ Regla absoluta:
  // Si TODAS las palabras pertenecen al catálogo → ES saludo
  const allGreetingTokens = tokens.every(t => GREETING_WORDS.has(t));
  const allThanksTokens   = tokens.every(t => THANKS_WORDS.has(t));

  // ✅ Protección cruzada: evita clasificar gracias como saludo
  const isGreeting = allGreetingTokens;
  const isThanks   = !isGreeting && allThanksTokens;

  return {
    isGreeting,
    isThanks,
    normalized: normText
  };
}
