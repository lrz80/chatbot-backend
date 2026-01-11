// backend/src/lib/whatsapp/normalize.ts

/**
 * Normaliza el número DESTINO (negocio).
 * bodyTo suele venir como: "whatsapp:+15551234567" o "tel:+15551234567"
 */
export function normalizeToNumber(bodyTo: string): {
  numero: string;
  numeroSinMas: string;
} {
  const raw = (bodyTo || "")
    .replace(/^whatsapp:/i, "")
    .replace(/^tel:/i, "")
    .trim();

  const numero = raw.startsWith("+") ? raw : `+${raw}`;
  const numeroSinMas = numero.replace(/^\+/, "");

  return { numero, numeroSinMas };
}

/**
 * Normaliza el número ORIGEN (cliente).
 * Devuelve:
 *  - fromNumber: número con +
 *  - contactoNorm: clave canónica (solo dígitos y +) para DB/estado/dedupe.
 */
export function normalizeFromNumber(bodyFrom: string): {
  fromNumber: string;
  contactoNorm: string;
} {
  const raw = (bodyFrom || "")
    .replace(/^whatsapp:/i, "")
    .replace(/^tel:/i, "")
    .trim();

  const fromNumber = raw.startsWith("+") ? raw : `+${raw}`;
  const contactoNorm = fromNumber.replace(/[^\d+]/g, "");

  return { fromNumber, contactoNorm };
}

/**
 * Quita saludos iniciales comunes para no sesgar intención/FAQ.
 */
export function stripLeadGreetings(t: string): string {
  return (t || "")
    .replace(
      /^\s*(hola|hello|hi|hey|saludos|buenas(?:\s+(tardes|noches|dias|días))?|buenos\s+(dias|días))[\s!.,-]*/i,
      ""
    )
    .trim();
}

/**
 * Detecta si el texto contiene solo números (ej: "1", "123").
 */
export function isNumericOnly(t: string): boolean {
  return /^\s*\d+\s*$/.test(t || "");
}
