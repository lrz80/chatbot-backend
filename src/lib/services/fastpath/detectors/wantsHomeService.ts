export function wantsHomeService(text: string) {
  const t = String(text || "").toLowerCase();

  // ES
  const es =
    /\b(a\s+domicilio|servicio\s+a\s+domicilio|domicilio)\b/.test(t) ||
    /\b(van\s+a\s+mi\s+casa|en\s+mi\s+casa|recogen|recoger)\b/.test(t);

  // EN
  const en =
    /\b(home\s+service|mobile\s+service|do\s+you\s+come\s+to\s+my\s+home)\b/.test(t) ||
    /\b(delivery|pickup)\b/.test(t);

  return es || en;
}
