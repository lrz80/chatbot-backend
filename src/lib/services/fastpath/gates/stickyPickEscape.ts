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
    /\b(ubicaci[oó]n|direcci[oó]n|location|address)\b/.test(t) ||

    // ✅ NUEVO: el usuario cambió a “catálogo general / recomendación”
    /\b(que\s+servicios\s+ofrecen|servicios\s+ofrecen|que\s+tienen|que\s+hacen|que\s+ofrecen)\b/.test(t) ||
    /\b(servicios|services|cat[aá]logo|catalog|men[uú]|menu|lista)\b/.test(t) ||
    /\b(recom(i|í)end(a|as|ame)?|recommend|suggest|sugerencia|que\s+me\s+recomiendas)\b/.test(t) ||

    // ✅ NUEVO: “más info” (incluye tu caso “quiero mas inf”)
    /\b(m[aá]s\s*info(rmaci[oó]n)?|quiero\s+m[aá]s\s+inf|quiero\s+m[aá]s\s+info|dame\s+m[aá]s\s+info|m[aá]s\s+detalles|detalles)\b/.test(t) ||
    /\b(more\s+info(rmation)?|more\s+details|tell\s+me\s+more|details)\b/.test(t)
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
