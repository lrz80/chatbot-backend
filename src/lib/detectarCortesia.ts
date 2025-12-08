function normalizeCourtesy(text: string) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // quita acentos
    .replace(/[¡!¿?\.,]/g, ' ')       // quita signos
    .replace(/\s+/g, ' ')             // normaliza espacios
    .trim();
}

const GREETINGS = new Set([
  'hola',
  'hola buenos dias',
  'hola buen dia',
  'hola buenas tardes',
  'hola buenas noches',
  'buenos dias',
  'buenas tardes',
  'buenas noches',
  'buen dia',
  'saludos',
  'hello',
  'hi',
  'hey',
  'hey there',
  'good morning',
  'good afternoon',
  'good evening',
  'good night',
  'gm',
  'gn'
]);

const THANKS = new Set([
  'gracias',
  'muchas gracias',
  'muchisimas gracias',
  'mil gracias',
  'se agradece',
  'te lo agradezco',
  'muy amable',
  'thank you',
  'thanks',
  'thanks a lot',
  'thanks so much',
  'thanx',
  'thx',
  'i appreciate it',
  'appreciate it'
]);

export function detectarCortesia(text: string): {
  isGreeting: boolean;
  isThanks: boolean;
  normalized: string;
} {
  const t = normalizeCourtesy(text);

  return {
    isGreeting: GREETINGS.has(t),
    isThanks: THANKS.has(t),
    normalized: t
  };
}
