// src/lib/appointments/booking/text.ts
import { DateTime } from "luxon";

export const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export function normalizeText(s: string) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s:@.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hasExplicitDateTime(text: string) {
  return /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/.test(String(text || ""));
}

export function hasAppointmentContext(text: string) {
  const t = normalizeText(text);
  const agendLike = /\bagend+a+\w*\b/;
  const bookLike = /\b(cita|consulta|reservar|reserva|turno|appointment|booking|schedule)\b/;
  return agendLike.test(t) || bookLike.test(t);
}

export function isCapabilityQuestion(text: string) {
  const t = normalizeText(text);

  const looksLikeQuestion =
    /\?/.test(text) || /\b(que|qué|como|cómo|cuál|cual)\b/.test(t);

  const q =
    /\b(puede|pueden|se puede|puedes|podria|podrían|capaz|permite|permiten|hace|hacen|incluye|incluyen)\b/.test(t) ||
    /\b(can you|can it|does it|do you|is it able to|are you able to)\b/.test(t);

  const bookingCapability =
    /\b(reserva|reservas|reservar|agenda|agendas|agendar|agendame|agéndame|programa|programas|programar)\b/.test(t) ||
    /\b(schedule|schedules|book|books|booking)\b/.test(t);

  const shortNoQuestionMark =
    t.length <= 30 && /\b(reserva|agenda|agendar|reservar|schedule|book|booking)\b/.test(t);

  if (shortNoQuestionMark) return true;
  if (looksLikeQuestion && bookingCapability) return true;
  return q && looksLikeQuestion;
}

export function isDirectBookingRequest(text: string) {
  const t = normalizeText(text);
  return (
    /\b(quiero|quisiera|necesito|me gustaria|me gustaría|vamos a|podemos)\s+(agendar|reservar|programar)\b/.test(t) ||
    /\b(agendame|agéndame|reservame|resérvame|programame|prográmame)\b/.test(t) ||
    /\b(book me|schedule me|reserve)\b/.test(t)
  );
}

export function detectDaypart(text: string): "morning" | "afternoon" | null {
  const t = normalizeText(text);

  // ✅ Morning intent
  if (
    /\b(manana|mañana|morning|temprano|por la manana|por la mañana|antes del mediodia|antes del mediodía)\b/i.test(t) ||
    /\b([1-9]|1[0-1])\s*(am|a\.m\.)\b/i.test(t) // "9am", "10 a.m."
  ) {
    return "morning";
  }

  // ✅ Afternoon/Evening/Night intent (tu sistema lo agrupa como "afternoon")
  if (
    /\b(tarde|afternoon|por la tarde|despues del mediodia|después del mediodía)\b/i.test(t) ||
    /\b(noche|evening|night|por la noche)\b/i.test(t) ||
    /\b(1[0-2]|[1-9])\s*(pm|p\.m\.)\b/i.test(t) // "5pm", "7 p.m."
  ) {
    return "afternoon";
  }

  // ✅ Señales conversacionales: "más tarde / más temprano"
  // Si el usuario dice "más temprano", normalmente quiere mañana.
  if (/\b(mas temprano|más temprano|tempranito|early)\b/i.test(t)) return "morning";

  // Si dice "más tarde", suele ser tarde/noche.
  if (/\b(mas tarde|más tarde|later)\b/i.test(t)) return "afternoon";

  return null;
}

export function detectPurpose(text: string): string | null {
  const t = normalizeText(text);

  if (/\b(demo|demostracion|demostración|demonstration)\b/.test(t)) return "demo";
  if (/\b(clase|class|trial)\b/.test(t)) return "clase";
  if (/\b(cita|appointment|appt)\b/.test(t)) return "cita";
  if (/\b(consulta|consultation|asesoria|asesoría)\b/.test(t)) return "consulta";
  if (/\b(llamada|call|phone)\b/.test(t)) return "llamada";
  if (/\b(visita|visit|presencial|in person)\b/.test(t)) return "visita";
  if (/\b(reservar|reserva|turno|agendar|agenda)\b/.test(t)) return "cita";

  return null;
}

export function wantsToCancel(text: string) {
  const t = normalizeText(text);
  return /\b(cancelar|cancela|olvida|stop|salir|exit|no gracias|nah|nope|ya no|dejalo|dejalo asi|deja eso|later)\b/i.test(t);
}

export function wantsMoreSlots(text: string) {
  const t = normalizeText(text);
  return /\b(otro|otra|otros|otras|mas|más|siguientes|alternativas|otra hora|otras horas|otro horario|otros horarios|mas opciones|más opciones|dame mas|dame más|ver mas|ver más)\b/i.test(t);
}

export function wantsAnotherDay(s: string) {
  const t = String(s || "").toLowerCase();
  return /\b(otro dia|otro día|otro dia\?|otro día\?|otro día\*|mañana|pasado mañana|otro día diferente|another day|different day|next day)\b/i.test(t);
}

export function wantsToChangeTopic(text: string) {
  const t = String(text || "").toLowerCase();
  return (
    /\b(precio|precios|cuanto|cuánto|tarifa|costo|costos)\b/i.test(t) ||
    /\b(price|prices|pricing|cost|costs|rate|rates|fee|fees)\b/i.test(t) ||
    /\b(how\s*much|what'?s\s+the\s+price|what\s+is\s+the\s+price)\b/i.test(t) ||
    /\b(horario|horarios|hours|open|close|abren|cierran)\b/i.test(t) ||
    /\b(ubicacion|ubicación|direccion|dirección|address|where)\b/i.test(t) ||
    /\b(info|informacion|información|details|mas informacion|más información)\b/i.test(t) ||
    /\b(como funciona|cómo funciona|how does it work|how it works)\b/i.test(t) ||
    /\b(cancelar|cancela|olvida|stop|salir|exit)\b/i.test(t)
  );
}

export function matchesBookingIntent(text: string, terms: string[]) {
  const t = normalizeText(text);
  return terms.some((term) => {
    const x = normalizeText(term);
    if (!x) return false;
    if (x.includes(" ")) return t.includes(x);
    return new RegExp(`\\b${x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t);
  });
}

export function extractDateTimeToken(input: string): string | null {
  const m = String(input || "").match(/\b(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\b/);
  return m?.[1] || null;
}

export function extractDateOnlyToken(input: string): string | null {
  const raw = String(input || "").toLowerCase().trim();

  // ----------------------------------------
  // 1) Detecta fecha exacta YYYY-MM-DD (la tuya)
  // ----------------------------------------
  const explicit = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  const hasDateTime = /\b\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\b/.test(raw);
  if (explicit && !hasDateTime) return explicit[1];

  // ----------------------------------------
  // 2) Palabras relativas: hoy, mañana, pasado mañana
  // ----------------------------------------
  const today = DateTime.now();
  if (/\bhoy\b/.test(raw)) {
    return today.toFormat("yyyy-MM-dd");
  }

  if (/\bmañana\b/.test(raw)) {
    return today.plus({ days: 1 }).toFormat("yyyy-MM-dd");
  }

  if (/\bpasado\s+mañana\b/.test(raw)) {
    return today.plus({ days: 2 }).toFormat("yyyy-MM-dd");
  }

  // ----------------------------------------
  // 3) Días de la semana: lunes, martes, ...
  // ----------------------------------------
  const dias: Record<string, number> = {
    "lunes": 1,
    "martes": 2,
    "miércoles": 3,
    "miercoles": 3,
    "jueves": 4,
    "viernes": 5,
    "sábado": 6,
    "sabado": 6,
    "domingo": 7,
  };

  for (const d of Object.keys(dias)) {
    if (raw.includes(d)) {
      const targetDow = dias[d];
      const currDow = today.weekday; // lunes=1...domingo=7
      let diff = targetDow - currDow;
      if (diff <= 0) diff += 7; // siguiente ocurrencia
      return today.plus({ days: diff }).toFormat("yyyy-MM-dd");
    }
  }

  // ----------------------------------------
  // 4) Fechas como: "el 15", "15", "para el 23"
  //    NO meses, solo día del mes actual
  // ----------------------------------------
  const mDia = raw.match(/\b(?:el\s+)?(\d{1,2})\b/);
  if (mDia) {
    const dia = Number(mDia[1]);
    if (dia >= 1 && dia <= 31) {
      const tentative = today.set({ day: dia });
      // Si ya pasó este mes, usar el siguiente mes
      if (tentative < today.startOf("day")) {
        return tentative.plus({ months: 1 }).toFormat("yyyy-MM-dd");
      }
      return tentative.toFormat("yyyy-MM-dd");
    }
  }

  return null;
}

// ✅ Extrae hora tipo "5pm", "5 pm", "17", "17:30", "a las 5", "a las 5:30"
export function extractTimeOnlyToken(raw: string): string | null {
  const s = String(raw || "").toLowerCase().trim();

  // 1) HH:mm (24h)
  let m = s.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) return `${m[1].padStart(2, "0")}:${m[2]}`;

  // 2) HH solo (ambiguo). Solo lo usamos si NO parece pregunta de hora ("a las", "tienes", "?")
// porque esas frases ya se cubren mejor con las otras reglas.
m = s.match(/\b([01]?\d|2[0-3])\b/);

const isPureChoice =
  /^\s*[1-5]\s*$/.test(s) ||
  /^\s*(opcion|opción)\s*[1-5]\s*$/.test(s);

const looksLikeTimeQuestion =
  /\b(a\s+las|a\s+la|para\s+las|para\s+la|tienes|hay|puedes|podemos)\b/.test(s) || /\?/.test(raw);

if (m && !isPureChoice && !looksLikeTimeQuestion) {
  const hh = Number(m[1]);
  if (hh >= 0 && hh <= 23) return `${String(hh).padStart(2, "0")}:00`;
}

  // 3) 5pm / 5 pm / 5:30pm / 5:30 pm
  m = s.match(/\b(1[0-2]|[1-9])(?::([0-5]\d))?\s*(am|pm)\b/);
  if (m) {
    let hh = Number(m[1]);
    const mm = m[2] ? Number(m[2]) : 0;
    const ap = m[3];

    if (ap === "pm" && hh !== 12) hh += 12;
    if (ap === "am" && hh === 12) hh = 0;

    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }

  // 4) "a las 5" / "a las 5:30"
  m = s.match(/\ba\s+las\s+(1[0-2]|[1-9]|1\d|2[0-3])(?::([0-5]\d))?\b/);
  if (m) {
    const hh = Number(m[1]);
    const mm = m[2] ? Number(m[2]) : 0;
    // sin am/pm asumimos formato 24h si hh>=13, si no es ambiguo
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }

  return null;
}

export type TimeConstraint =
  | { kind: "after"; hhmm: string }      // "después de las 4"
  | { kind: "before"; hhmm: string }     // "antes de las 4"
  | { kind: "around"; hhmm: string }     // "tipo 5", "tipo 5 y algo"
  | { kind: "earliest" }                 // "lo más temprano"
  | { kind: "any_afternoon" }            // "cuando puedas por la tarde"
  | { kind: "any_morning" };             // "cuando puedas por la mañana"

export function extractTimeConstraint(raw: string): TimeConstraint | null {
  const t = String(raw || "").toLowerCase();

  // 1) "lo más temprano", "tempranito", "earliest"
  if (/\b(lo mas temprano|lo más temprano|tempranito|earliest|as early as possible)\b/i.test(t)) {
    return { kind: "earliest" };
  }

  // 2) "cuando puedas por la tarde / mañana"
  if (/\b(cuando puedas|cuando puedas)\b/i.test(t) && /\b(tarde|afternoon|noche|evening)\b/i.test(t)) {
    return { kind: "any_afternoon" };
  }
  if (/\b(cuando puedas|when you can|whenever)\b/i.test(t) && /\b(manana|mañana|morning|temprano)\b/i.test(t)) {
    return { kind: "any_morning" };
  }

  // 3) "después de las 4", "after 4"
  if (/\b(despu(e|é)s de (las|la)?\s*\d{1,2}(:\d{2})?)\b/i.test(t) || /\bafter\s+\d{1,2}(:\d{2})?\b/i.test(t)) {
    const hhmm = extractTimeOnlyToken(t);
    if (hhmm) return { kind: "after", hhmm };
  }

  // 4) "antes de las 4", "before 4"
  if (/\b(antes de (las|la)?\s*\d{1,2}(:\d{2})?)\b/i.test(t) || /\bbefore\s+\d{1,2}(:\d{2})?\b/i.test(t)) {
    const hhmm = extractTimeOnlyToken(t);
    if (hhmm) return { kind: "before", hhmm };
  }

  // 5) "tipo 5", "tipo 5 y algo", "around 5"
  if (/\b(tipo|como|around|about)\b/i.test(t)) {
    const hhmm = extractTimeOnlyToken(t);
    if (hhmm) return { kind: "around", hhmm };
  }

  // 6) "5 y algo" (sin decir "tipo")
  if (/\b(\d{1,2})\s*y\s+algo\b/i.test(t)) {
    const hhmm = extractTimeOnlyToken(t);
    if (hhmm) return { kind: "around", hhmm };
  }

  return null;
}

export function removeOnce(haystack: string, needle: string) {
  const idx = haystack.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return haystack;
  return (haystack.slice(0, idx) + " " + haystack.slice(idx + needle.length)).trim();
}

export function cleanNameCandidate(raw: string): string {
  return String(raw || "")
    .replace(/[,\|;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseEmail(input: string) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return null;
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw);
  return ok ? raw : null;
}

export function parseFullName(input: string) {
  const raw = String(input || "").trim().replace(/\s+/g, " ");
  if (!raw) return null;

  const parts = raw.split(" ").filter(Boolean);
  if (parts.length < 2) return null;

  const letters = raw.replace(/[^a-zA-ZáéíóúüñÁÉÍÓÚÜÑ\s'-]/g, "").trim();
  if (letters.split(" ").filter(Boolean).length < 2) return null;

  return raw;
}

// "Juan Perez, juan@email.com, 2026-01-21 14:00"
export function parseAllInOne(input: string, timeZone: string, durationMin: number, parseDateTimeExplicit: any) {
  const raw = String(input || "").trim();

  const email = raw.match(EMAIL_REGEX)?.[0]?.toLowerCase() || null;

  const dtToken = extractDateTimeToken(raw);
  const dtParsed = dtToken ? parseDateTimeExplicit(dtToken, timeZone, durationMin) : null;

  const startISO =
    (dtParsed as any)?.error === "PAST_SLOT" ? null : (dtParsed as any)?.startISO || null;
  const endISO =
    (dtParsed as any)?.error === "PAST_SLOT" ? null : (dtParsed as any)?.endISO || null;

  let nameCandidate = raw;
  if (email) nameCandidate = removeOnce(nameCandidate, email);
  if (dtToken) nameCandidate = removeOnce(nameCandidate, dtToken);

  nameCandidate = cleanNameCandidate(nameCandidate);

  nameCandidate = nameCandidate
    .replace(/\b(quiero|quisiera|me gustaria|hola|buenas|buenos|agendar|agenda|cita|consulta|demo|clase|reservar|reserva|turno|appointment|booking|schedule|para|por favor|pls|please)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  nameCandidate = nameCandidate
    .replace(/\b(mi nombre es|soy|me llamo|name is|i am)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  const name = nameCandidate ? parseFullName(nameCandidate) : null;

  return { name, email, startISO, endISO };
}

export function parseNameEmailOnly(input: string) {
  const raw = String(input || "").trim();
  const email = raw.match(EMAIL_REGEX)?.[0]?.toLowerCase() || null;

  let nameCandidate = raw;
  if (email) nameCandidate = removeOnce(nameCandidate, email);

  nameCandidate = cleanNameCandidate(nameCandidate)
    .replace(/\b(mi nombre es|soy|me llamo|name is|i am|hola|buenas|buenos|por favor|pls|please)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  const name = nameCandidate ? parseFullName(nameCandidate) : null;
  return { name, email };
}

export function buildAskAllMessage(idioma: "es" | "en", purpose?: string | null) {
  const p = purpose ? ` (${purpose})` : "";

  if (idioma === "en") {
    return (
      `Sure! I can help you with that.\n` +
      `Please send me everything together in ONE message:\n` +
      `Your full name, email, and the date & time you’d like.\n` +
      `Example: John Smith, john@email.com, 2026-01-21 14:00`
    );
  }

  return (
    `¡Claro! Te ayudo con eso.\n` +
    `Solo envíame todo junto en **un solo mensaje**:\n` +
    `Tu nombre completo, email y la fecha y hora que te gustaría.\n` +
    `Ejemplo: Juan Pérez, juan@email.com, 2026-01-21 14:00`
  );
}

export function wantsSpecificTime(text: string) {
  const t = normalizeText(text);

  // si el usuario solo manda "1"..."5" es selección, no hora
  if (/^\s*[1-5]\s*$/.test(String(text || "").trim())) return false;

  // señales típicas de pedir una hora
  const asking =
    /\b(tienes|tiene|hay|habra|habrá|puedes|puede|podemos|puedo)\b/.test(t) ||
    /\?/.test(text);

  // contiene hora en cualquier formato
  const hasTime = !!extractTimeOnlyToken(text);

  // ejemplos: "tienes a las 5?", "a las 5pm", "5pm?"
  const hasAt =
    /\b(a\s+las|a\s+la|para\s+las|para\s+la|at)\b/.test(t);

  return hasTime && (asking || hasAt);
}
