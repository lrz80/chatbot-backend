export function isExplicitHumanRequest(text: string): boolean {
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!t) return false;

  // ✅ WHITELIST: nunca debe escalar
  if (
    /^no gracias\b/.test(t) ||
    /^no gracia\b/.test(t) || // typo común
    /^gracias\b/.test(t) ||
    /^muchas gracias\b/.test(t) ||
    /^ok\b$/.test(t) ||
    /^ok gracias\b/.test(t) ||
    /^thanks\b/.test(t) ||
    /^thank you\b/.test(t) ||
    /^no thanks\b/.test(t)
  ) {
    return false;
  }

  // ✅ SOLO si lo pide explícitamente
  return (
    /\b(quiero|necesito)\b.*\b(hablar|hablo)\b.*\b(con)\b.*\b(una persona|alguien|un humano|un agente|representante)\b/.test(t) ||
    /\b(una persona|un humano|un agente|representante)\b/.test(t) && /\b(hablar|comunicar|pasar|contactar)\b/.test(t) ||
    /\b(human|agent|representative|real person|someone real|live agent)\b/.test(t)
  );
}
