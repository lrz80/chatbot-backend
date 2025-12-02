// src/lib/nlu/isGenericMoreInfo.ts

// Quita acentos y normaliza espacios
function normalizeBasic(text: string): string {
  if (!text) return "";
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") // quita acentos
    .toLowerCase()
    .trim()
    .replace(/[\.\!\?…]+$/g, "")    // quita signos al final
    .replace(/\s+/g, " ");          // colapsa espacios
}

// Quita saludos al inicio para no confundir con "hola mas info"
function stripGreetings(text: string): string {
  let t = text.trim().toLowerCase();
  t = t.replace(
    /^(hola|buenas(?: dias| tardes| noches)?|buenos dias|hello|hi|hey)\s*/i,
    ""
  );
  return t.trim();
}

/**
 * Detecta pedidos genéricos de "más información" al final del mensaje,
 * en variaciones como:
 * - "quiero mas inf"
 * - "me gustaria mas info"
 * - "mas informacion"
 * - "info", "informacion" si el mensaje es muy cortito (1–3 palabras)
 */
export function isGenericMoreInfo(raw: string): boolean {
  if (!raw) return false;

  // 1) normalizar
  const noAccent = normalizeBasic(raw);
  const noGreeting = stripGreetings(noAccent);

  if (!noGreeting) return false;

  const words = noGreeting.split(" ");
  const tail = words.slice(-3).join(" "); // últimas 3 palabras

  // Caso fuerte: expresiones claras de "más info"
  const strongPattern = /\b(mas info|mas inf|mas informacion|mas informacion)\s*$/i;
  if (strongPattern.test(tail)) {
    return true;
  }

  // Caso corto: mensajes muy pequeños tipo "más info", "info", "informacion"
  if (words.length <= 3) {
    const shortTail = words.join(" ");
    if (/\b(info|informacion)\s*$/i.test(shortTail)) {
      return true;
    }
  }

  return false;
}
