export type ServiceInfoNeed = "price" | "duration" | "includes" | "any";

export function wantsServiceInfo(text: string): ServiceInfoNeed | null {
  const t = String(text || "").trim().toLowerCase();

  // precio / costo
  if (/\b(cu[aá]nto\s+cuesta|precio|vale|costo|cost|price|how\s+much)\b/i.test(t)) {
    return "price";
  }

  // duración
  if (/\b(cu[aá]nto\s+dura|duraci[oó]n|minutos|minutes|duration|how\s+long)\b/i.test(t)) {
    return "duration";
  }

  // qué incluye
  if (/\b(qu[eé]\s+incluye|incluye|incluido|includes|what('s)?\s+included)\b/i.test(t)) {
    return "includes";
  }

  // “info” genérica de servicio
  if (/\b(info|informaci[oó]n|details|detail)\b/i.test(t)) {
    return "any";
  }

  return null;
}
