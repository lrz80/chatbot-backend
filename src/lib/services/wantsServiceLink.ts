export function wantsServiceLink(text: string) {
  const t = String(text || "").toLowerCase();

  // ES + EN
  return (
    /\b(link|enlace|url)\b/.test(t) ||
    /\b(reservar|reservación|reserva|agenda|agendar|book|booking|schedule)\b/.test(t) ||
    /\b(comprar|buy|purchase)\b/.test(t) ||
    /\b(mandame|env(i|í)ame|send me)\b/.test(t)
  );
}
