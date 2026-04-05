//src/lib/appointments/booking/parsers/dateTimeParsers.ts
import { DateTime } from "luxon";
import { normalizeText } from "../shared/textCore";

export function hasExplicitDateTime(text: string) {
  return /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/.test(String(text || ""));
}

export function extractDateTimeToken(input: string): string | null {
  const m = String(input || "").match(/\b(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\b/);
  return m?.[1] || null;
}

export function extractDateOnlyToken(input: string, timeZone?: string): string | null {
  const raw = String(input || "").toLowerCase().trim();
  const today = (timeZone ? DateTime.now().setZone(timeZone) : DateTime.now()).startOf("day");

  if (/\b\d{1,2}\s*-\s*\d{1,2}\b/.test(raw)) {
    // rango de opciones, no usar como fecha suelta
  }

  const explicit = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  const hasDateTime = /\b\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\b/.test(raw);
  if (explicit && !hasDateTime) return explicit[1];

  if (/\bhoy\b/.test(raw)) {
    return today.toFormat("yyyy-MM-dd");
  }

  if (/\bpasado\s+(mañana|manana)\b/.test(raw)) {
    return today.plus({ days: 2 }).toFormat("yyyy-MM-dd");
  }

  if (/\b(mañana|manana)\b/.test(raw)) {
    return today.plus({ days: 1 }).toFormat("yyyy-MM-dd");
  }

  const dias: Record<string, number> = {
    lunes: 1,
    martes: 2,
    miércoles: 3,
    miercoles: 3,
    jueves: 4,
    viernes: 5,
    sábado: 6,
    sabado: 6,
    domingo: 7,
  };

  for (const d of Object.keys(dias)) {
    if (raw.includes(d)) {
      const targetDow = dias[d];
      const currDow = today.weekday;
      let diff = targetDow - currDow;
      if (diff < 0) diff += 7;
      return today.plus({ days: diff }).toFormat("yyyy-MM-dd");
    }
  }

  const mDiaExplicito = raw.match(/\b(?:para\s+el|para|el|dia|día|este)\s+(\d{1,2})\b/);
  if (mDiaExplicito) {
    const dia = Number(mDiaExplicito[1]);
    if (dia >= 1 && dia <= 31) {
      let tentative = today.set({ day: dia });
      if (tentative.day !== dia) {
        tentative = today.plus({ months: 1 }).set({ day: dia });
      }
      if (tentative < today) tentative = tentative.plus({ months: 1 });
      return tentative.toFormat("yyyy-MM-dd");
    }
  }

  if (!/\b\d{1,2}\s*-\s*\d{1,2}\b/.test(raw)) {
    const mDia = raw.match(/\b(\d{1,2})\b/);
    if (mDia) {
      const dia = Number(mDia[1]);
      if (dia >= 1 && dia <= 31) {
        let tentative = today.set({ day: dia });
        if (tentative.day !== dia) tentative = today.plus({ months: 1 }).set({ day: dia });
        if (tentative < today) tentative = tentative.plus({ months: 1 });
        return tentative.toFormat("yyyy-MM-dd");
      }
    }
  }

  return null;
}

// ✅ Extrae hora tipo "5pm", "5 pm", "17", "17:30", "a las 5", "a las 5:30"
export function extractTimeOnlyToken(raw: string): string | null {
  const s = String(raw || "").toLowerCase().trim();

  const hasExplicitTimeSignal =
    /\b(am|pm|a\.m\.|p\.m\.)\b/i.test(s) || /\b([01]?\d|2[0-3]):([0-5]\d)\b/.test(s);

  if (!hasExplicitTimeSignal) {
    const looksLikeChoice =
      /\b(opcion|opción|option|elige|escojo|pick|choose|nro|num|numero|número|#)\s*(\d)\b/.test(s) ||
      /^\s*(\d)\s*$/.test(s);

    if (looksLikeChoice) {
      const n = Number((s.match(/\b(\d)\b/) || [])[1]);
      if (n >= 1 && n <= 5) return null;
    }
  }

  const looksLikeChoice =
    /\b(opcion|opción|option|elige|escojo|pick|choose|nro|num|numero|número|#)\s*(\d)\b/.test(s) ||
    /^\s*(\d)\s*$/.test(s);

  if (looksLikeChoice) {
    const n = Number((s.match(/\b(\d)\b/) || [])[1]);
    if (n >= 1 && n <= 5) return null;
  }

  let m = s.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) return `${m[1].padStart(2, "0")}:${m[2]}`;

  m = s.match(/\b(1[0-2]|[1-9])(?::([0-5]\d))?\s*(am|pm)\b/);
  if (m) {
    let hh = Number(m[1]);
    const mm = m[2] ? Number(m[2]) : 0;
    const ap = m[3];

    if (ap === "pm" && hh !== 12) hh += 12;
    if (ap === "am" && hh === 12) hh = 0;

    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }

  m = s.match(/\ba\s+la(s)?\s+(1[0-2]|[1-9]|1\d|2[0-3])(?::([0-5]\d))?\b/);
  if (m) {
    const hh = Number(m[2]);
    const mm = m[3] ? Number(m[3]) : 0;
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }

  const hasTimeCue =
    /\b(at|a\s+las|a\s+la|para\s+las|para\s+la|around|about|roughly|approx|aprox|aproximadamente|sobre|tipo|como|alrededor)\b/.test(
      s
    );

  if (hasTimeCue) {
    m = s.match(/\b([01]?\d|2[0-3])\b/);
    if (m) {
      let hh = Number(m[1]);

      const hasAmPm = /\b(am|pm|a\.m\.|p\.m\.)\b/.test(s);
      const hasMorningWord = /\b(manana|mañana|morning|temprano)\b/.test(s);
      const approxCue =
        /\b(tipo|como|alrededor|around|about|roughly|approx|aprox|aproximadamente)\b/.test(s);

      if (!hasAmPm && !hasMorningWord && approxCue && hh >= 1 && hh <= 7) {
        hh += 12;
      }

      return `${String(hh).padStart(2, "0")}:00`;
    }
  }

  return null;
}

export function buildDateTimeFromText(
  text: string,
  timeZone: string,
  durationMin: number,
  opts?: {
    minLeadMinutes?: number;
    businessHours?: { start: string; end: string };
  }
):
  | { startISO: string; endISO: string }
  | { error: "PAST_SLOT" | "OUTSIDE_HOURS" }
  | null {
  const dateISO = extractDateOnlyToken(text, timeZone);
  const hhmm = extractTimeOnlyToken(text);

  if (!dateISO || !hhmm) return null;

  const [hStr, mStr] = hhmm.split(":");
  let hh = Number(hStr);
  const mm = Number(mStr);

  const s = String(text || "").toLowerCase();
  const hasAmPm = /\b(am|pm|a\.m\.|p\.m\.)\b/.test(s);
  const hasAtCue = /\b(a\s+la(s)?|para\s+la(s)?)\b/.test(s);

  if (!hasAmPm && hasAtCue && hh >= 1 && hh <= 7) {
    hh += 12;
  }

  const start = DateTime.fromISO(
    `${dateISO}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`,
    { zone: timeZone }
  );

  if (!start.isValid) return null;

  const now = DateTime.now().setZone(timeZone);
  const minLead = Math.max(0, opts?.minLeadMinutes ?? 5);
  if (start < now.plus({ minutes: minLead })) {
    return { error: "PAST_SLOT" };
  }

  const bh = opts?.businessHours;
  if (bh?.start && bh?.end) {
    const [oh, om] = bh.start.split(":").map(Number);
    const [ch, cm] = bh.end.split(":").map(Number);

    const open = start.set({ hour: oh, minute: om, second: 0, millisecond: 0 });
    const close = start.set({ hour: ch, minute: cm, second: 0, millisecond: 0 });

    const end = start.plus({ minutes: durationMin });

    if (start < open || end > close) {
      return { error: "OUTSIDE_HOURS" };
    }
  }

  const end = start.plus({ minutes: durationMin });
  return { startISO: start.toISO()!, endISO: end.toISO()! };
}

export type TimeConstraint =
  | { kind: "after"; hhmm: string }
  | { kind: "before"; hhmm: string }
  | { kind: "around"; hhmm: string }
  | { kind: "earliest" }
  | { kind: "any_afternoon" }
  | { kind: "any_morning" };

export function extractTimeConstraint(raw: string): TimeConstraint | null {
  const t = String(raw || "").toLowerCase().trim();

  const has = (re: RegExp) => re.test(t);

  if (
    has(/\b(lo\s+m[aá]s\s+temprano|tempranito|lo\s+m[aá]s\s+pronto|a\s+primera\s+hora|lo\s+antes\s+posible)\b/i) ||
    has(/\b(earliest|as\s+early\s+as\s+possible|as\s+soon\s+as\s+possible|first\s+thing|asap)\b/i)
  ) {
    return { kind: "earliest" };
  }

  const anyTimePref =
    has(/\b(cuando\s+puedas|cuando\s+se\s+pueda|cualquier\s+hora|cuando\s+sea|me\s+da\s+igual|sin\s+preferencia|como\s+sea)\b/i) ||
    has(/\b(when\s+you\s+can|whenever|any\s+time|no\s+preference|doesn'?t\s+matter|whatever\s+works)\b/i);

  if (anyTimePref && has(/\b(ma[nñ]ana|morning|temprano|early)\b/i)) {
    return { kind: "any_morning" };
  }

  if (anyTimePref && has(/\b(tarde|afternoon)\b/i)) {
    return { kind: "any_afternoon" };
  }

  if (
    has(/\b(despu[eé]s\s+de\s+(las|la)?\s*\d{1,2}(:\d{2})?)\b/i) ||
    has(/\b(a\s+partir\s+de\s+(las|la)?\s*\d{1,2}(:\d{2})?)\b/i) ||
    has(/\b(after|from)\s+\d{1,2}(:\d{2})?\s*(am|a\.m\.|pm|p\.m\.)?\b/i)
  ) {
    const hhmm = extractTimeOnlyToken(t);
    if (hhmm) return { kind: "after", hhmm };
  }

  if (
    has(/\b(antes\s+de\s+(las|la)?\s*\d{1,2}(:\d{2})?)\b/i) ||
    has(/\b(no\s+m[aá]s\s+tarde\s+de\s+(las|la)?\s*\d{1,2}(:\d{2})?)\b/i) ||
    has(/\b(before|no\s+later\s+than)\s+\d{1,2}(:\d{2})?\s*(am|a\.m\.|pm|p\.m\.)?\b/i)
  ) {
    const hhmm = extractTimeOnlyToken(t);
    if (hhmm) return { kind: "before", hhmm };
  }

  if (
    has(/\b(tipo|como|aprox(?:\.|imadamente)?|aproximad(?:amente)?|alrededor\s+de|por\s+ah[ií])\b/i) ||
    has(/\b(around|about|approx(?:\.|imately)?|roughly)\b/i)
  ) {
    const hhmm = extractTimeOnlyToken(t);
    if (hhmm) return { kind: "around", hhmm };
  }

  if (
    has(/\b(\d{1,2})\s+y\s+(algo|pico)\b/i) ||
    has(/\b(\d{1,2})\s*-\s*ish\b/i) ||
    has(/\b(\d{1,2})ish\b/i)
  ) {
    const hhmm = extractTimeOnlyToken(t);
    if (hhmm) return { kind: "around", hhmm };
  }

  return null;
}