//src/lib/voice/returningCustomer/normalizePhone.ts
function clean(value: unknown): string {
  return String(value ?? "").trim();
}

/**
 * Normaliza números comunes al formato E.164.
 *
 * No intenta adivinar códigos internacionales desconocidos.
 * Para números estadounidenses de 10 dígitos agrega +1.
 */
export function normalizeReturningCustomerPhone(
  value: unknown
): string | null {
  const raw = clean(value);

  if (!raw) {
    return null;
  }

  const digits = raw.replace(/\D/g, "");

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  if (digits.length >= 11 && digits.length <= 15) {
    return `+${digits}`;
  }

  return null;
}