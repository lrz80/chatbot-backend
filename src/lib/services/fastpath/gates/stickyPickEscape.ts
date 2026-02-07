// backend/src/lib/services/fastpath/gates/stickyPickEscape.ts

type Lang = "es" | "en";

export function isStickyPickOptOut(text: string) {
  const t = String(text || "").toLowerCase().trim();
  return /\b(no\s*gracias|gracias\s*no|ya\s*no|no\s*quiero|cancel(a|ar)|stop|parar|deten|quit|salir)\b/.test(t);
}

export function isStickyPickDifferentQuestion(text: string) {
  const t = String(text || "").toLowerCase().trim();
  return (
    /\b(walk\s*-?\s*in(s)?|walkins?)\b/.test(t) ||
    /\b(cita|appointment|book|booking|reserv|agendar|schedule)\b/.test(t) ||
    /\b(horario|horarios|hours|open|close|abren|cierran)\b/.test(t) ||
    /\b(ubicaci[oó]n|direcci[oó]n|location|address)\b/.test(t)
  );
}

export function renderStickyPickOptOutReply(lang: Lang) {
  return lang === "en"
    ? "No problem 🙂 If you need anything else, just tell me."
    : "Perfecto 🙂 Si necesitas algo más, dime y te ayudo.";
}

export function renderStickyPickExpiredReply(lang: Lang) {
  return lang === "en"
    ? "That selection expired (it was pending for a while). Ask again and I’ll show the options again."
    : "Esa selección expiró (quedó pendiente por un rato). Vuelve a pedirme el servicio y te muestro las opciones otra vez.";
}

export function renderStickyPickRepromptReply(lang: Lang, lines: string) {
  return lang === "en"
    ? `Which option do you want? Reply with the number:\n${lines}`
    : `¿Cuál opción quieres? Responde con el número:\n${lines}`;
}
