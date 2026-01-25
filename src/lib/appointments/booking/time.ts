// src/lib/appointments/booking/time.ts
import { DateTime } from "luxon";
import type { HoursByWeekday } from "./types";

export const MIN_LEAD_MINUTES = 5;

type Slot = { startISO: string; endISO: string };

export function filterSlotsByDaypart(slots: Slot[], tz: string, daypart: "morning" | "afternoon") {
  return (slots || []).filter((s) => {
    const h = DateTime.fromISO(s.startISO, { zone: tz }).hour;

    // Ajusta si tu “tarde” empieza a las 12
    if (daypart === "morning") return h < 12;
    return h >= 12;
  });
}

export function isPastSlot(startISO: string, timeZone: string) {
  const start = DateTime.fromISO(startISO, { zone: timeZone });
  const now = DateTime.now().setZone(timeZone);
  if (!start.isValid) return true;
  const minStart = now.plus({ minutes: MIN_LEAD_MINUTES });
  return start < minStart;
}

export function parseHHmm(hhmm: string) {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, min };
}

export function weekdayKey(dt: DateTime): keyof HoursByWeekday {
  const w = dt.weekday; // 1=Mon ... 7=Sun
  return (w === 1 ? "mon" :
          w === 2 ? "tue" :
          w === 3 ? "wed" :
          w === 4 ? "thu" :
          w === 5 ? "fri" :
          w === 6 ? "sat" : "sun");
}

export function isWithinBusinessHours(opts: {
  hours: HoursByWeekday | null;
  startISO: string;
  endISO: string;
  timeZone: string;
}) {
  const { hours, startISO, endISO, timeZone } = opts;
  if (!hours) return { ok: true as const };

  const start = DateTime.fromISO(startISO, { zone: timeZone });
  const end = DateTime.fromISO(endISO, { zone: timeZone });
  if (!start.isValid || !end.isValid) return { ok: false as const, reason: "invalid" as const };

  const key = weekdayKey(start);
  const dayHours = hours[key];
  if (!dayHours || !dayHours.start || !dayHours.end) {
    return { ok: false as const, reason: "closed" as const, key };
  }

  const st = parseHHmm(dayHours.start);
  const en = parseHHmm(dayHours.end);
  if (!st || !en) return { ok: false as const, reason: "invalid_hours" as const, key };

  const bizStart = start.set({ hour: st.h, minute: st.min, second: 0, millisecond: 0 });
  const bizEnd = start.set({ hour: en.h, minute: en.min, second: 0, millisecond: 0 });
  if (bizEnd <= bizStart) return { ok: false as const, reason: "invalid_hours" as const, key };

  const ok = start >= bizStart && end <= bizEnd;
  return ok
    ? { ok: true as const }
    : { ok: false as const, reason: "outside" as const, bizStart, bizEnd, key };
}

export function formatBizWindow(idioma: "es" | "en", bizStart: DateTime, bizEnd: DateTime) {
  const fmt = idioma === "en" ? "h:mm a" : "HH:mm";
  return `${bizStart.toFormat(fmt)} - ${bizEnd.toFormat(fmt)}`;
}

export function parseDateTimeExplicit(input: string, timeZone: string, durationMin: number) {
  const m = String(input || "").trim().match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/);
  if (!m) return null;

  const [_, date, hhmm] = m;
  const dt = DateTime.fromFormat(`${date} ${hhmm}`, "yyyy-MM-dd HH:mm", { zone: timeZone });
  if (!dt.isValid) return null;

  const startISO = dt.toISO();
  const endISO = dt.plus({ minutes: durationMin }).toISO();
  if (!startISO || !endISO) return null;

  if (isPastSlot(startISO, timeZone)) {
    return { startISO: null, endISO: null, timeZone, error: "PAST_SLOT" as const };
  }

  return { startISO, endISO, timeZone };
}

export function formatSlotHuman(opts: {
  startISO: string;
  timeZone: string;
  idioma: "es" | "en";
}) {
  const { startISO, timeZone, idioma } = opts;

  const dt = DateTime.fromISO(startISO, { zone: timeZone });
  if (!dt.isValid) return startISO;

  if (idioma === "en") {
    return dt.setLocale("en").toFormat("LLL d, yyyy 'at' h:mm a");
  }

  return dt.setLocale("es").toFormat("d LLL yyyy, h:mm a");
}

export function renderSlotsMessage(opts: {
  idioma: "es" | "en";
  timeZone: string;
  slots: Array<{ startISO: string; endISO: string }>;

  // ✅ nuevos
  intro?: boolean; // default true
  style?: "default" | "closest" | "more" | "sameDay" | "neutral";
  ask?: "number" | "anything"; // default number
}): string {
  const {
    idioma,
    timeZone,
    slots,
    intro = true,
    style = "default",
    ask = "number",
  } = opts;

  if (!slots.length) {
    return idioma === "en"
      ? "I'm sorry! I couldn’t find availability for that date. What other day works for you?"
      : "Lo siento! No encontré disponibilidad para esa fecha. ¿Qué otro día te funciona?";
  }

  const lines = slots.map((s, i) => {
    const human = formatSlotHuman({ startISO: s.startISO, timeZone, idioma });
    return `${i + 1}) ${human}`;
  });

  // ✅ intros más humanos (y opcionales)
  const introEnMap: Record<string, string> = {
    default: "Sure — here are a few times that are available:",
    closest: "I'm sorry! That exact time isn’t available. These are the closest options:",
    more: "No problem — here are a few more options:",
    sameDay: "Here are the available times for that day:",
    neutral: "",
  };

  const introEsMap: Record<string, string> = {
    default: "Claro — aquí tienes algunos horarios disponibles:",
    closest: "Lo siento! Esa hora exacta no está disponible. Estas son las opciones más cercanas:",
    more: "Perfecto — aquí van más opciones:",
    sameDay: "Estos son los horarios disponibles para ese día:",
    neutral: "",
  };

  const introLine =
    !intro || style === "neutral"
      ? ""
      : (idioma === "en" ? introEnMap[style] : introEsMap[style]) + "\n";

  const askLine =
    ask === "anything"
      ? idioma === "en"
        ? `Please Reply with a number (1-${slots.length}) or tell me a time (like "2pm" / "14:00").`
        : `Por favor Responde con un número (1-${slots.length}) o dime una hora (como "2pm" / "14:00").`
      : idioma === "en"
        ? `Please Reply with the number you prefer (1-${slots.length}).`
        : `Por favor Responde con el número que prefieras (1-${slots.length}).`;

  return `${introLine}${lines.join("\n")}\n${askLine}`.trim();
}

export function parseSlotChoice(text: string, max: number): number | null {
  const raw = String(text || "").trim();

  // Aseguramos que sea SOLO un número aislado.
  // No debe contener letras, "pm", "am", "a las", etc.
  // Limpia espacios, puntos o paréntesis, pero nada más.
  const m = raw.match(/^(?:opci[oó]n|option)?\s*([1-9])\s*[).]?\s*$/i);
  if (!m) return null;

  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1 || n > max) return null;

  return n;
}

export function filterSlotsNearTime(opts: {
  slots: Array<{ startISO: string; endISO: string }>;
  timeZone: string;
  hhmm: string;            // "17:00"
  windowMinutes?: number;  // default 120 (±2h)
  max?: number;            // default 5
}) {
  const { slots, timeZone, hhmm, windowMinutes = 120, max = 5 } = opts;
  const [hh, mm] = hhmm.split(":").map((x) => Number(x));

  // Toma el día del primer slot como referencia
  const first = slots[0]?.startISO;
  if (!first) return [];

  const day = DateTime.fromISO(first, { zone: timeZone });
  if (!day.isValid) return [];

  const target = day.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
  if (!target.isValid) return [];

  const scored = slots
    .map((sl) => {
      const dt = DateTime.fromISO(sl.startISO, { zone: timeZone });
      const diff = Math.abs(dt.toMillis() - target.toMillis());
      return { sl, diff };
    })
    .sort((a, b) => a.diff - b.diff);

  // filtra por ventana
  const within = scored.filter((x) => x.diff <= windowMinutes * 60 * 1000);

  const pick = (within.length ? within : scored).slice(0, max).map((x) => x.sl);
  return pick;
}

export function filterSlotsByConstraint(opts: {
  slots: Array<{ startISO: string; endISO: string }>;
  timeZone: string;
  constraint:
    | { kind: "after"; hhmm: string }
    | { kind: "before"; hhmm: string }
    | { kind: "around"; hhmm: string }
    | { kind: "earliest" }
    | { kind: "any_afternoon" }
    | { kind: "any_morning" };
  max?: number;
}) {
  const { slots, timeZone, constraint, max = 5 } = opts;
  if (!slots.length) return [];

  const firstDay = DateTime.fromISO(slots[0].startISO, { zone: timeZone });
  if (!firstDay.isValid) return [];

  const toTarget = (hhmm: string) => {
    const [hh, mm] = hhmm.split(":").map(Number);
    return firstDay.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
  };

  if (constraint.kind === "earliest") {
    return slots.slice(0, max);
  }

  if (constraint.kind === "any_morning") {
    const morning = slots.filter((s) => DateTime.fromISO(s.startISO, { zone: timeZone }).hour < 12);
    return (morning.length ? morning : slots).slice(0, max);
  }

  if (constraint.kind === "any_afternoon") {
    const aft = slots.filter((s) => DateTime.fromISO(s.startISO, { zone: timeZone }).hour >= 12);
    return (aft.length ? aft : slots).slice(0, max);
  }

  if (constraint.kind === "around") {
    return filterSlotsNearTime({ slots, timeZone, hhmm: constraint.hhmm, windowMinutes: 150, max });
  }

  if (constraint.kind === "after") {
    const target = toTarget(constraint.hhmm);
    const after = slots.filter((s) => DateTime.fromISO(s.startISO, { zone: timeZone }) >= target);
    return (after.length ? after : slots).slice(0, max);
  }

  if (constraint.kind === "before") {
    const target = toTarget(constraint.hhmm);
    const before = slots.filter((s) => DateTime.fromISO(s.startISO, { zone: timeZone }) <= target);
    return (before.length ? before : slots).slice(0, max);
  }

  return slots.slice(0, max);
}

export function makeConstraintFromUserRequest(opts: {
  hhmm?: string | null;
  explicitConstraint?:
    | { kind: "after"; hhmm: string }
    | { kind: "before"; hhmm: string }
    | { kind: "around"; hhmm: string }
    | { kind: "earliest" }
    | { kind: "any_afternoon" }
    | { kind: "any_morning" }
    | null;
}) {
  const { hhmm, explicitConstraint } = opts;

  // si ya viene "after/before/around/earliest/any_*", úsalo tal cual
  if (explicitConstraint) return explicitConstraint;

  // si el usuario solo dijo una hora ("tienes a las 5pm?"), lo tratamos como "around"
  if (hhmm) return { kind: "around" as const, hhmm };

  return null;
}

