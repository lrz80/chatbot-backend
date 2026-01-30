// src/lib/appointments/booking/slots.ts
import { DateTime } from "luxon";
import { googleFreeBusy } from "../../../services/googleCalendar";
import type { HoursByWeekday, Slot } from "./types";
import { parseHHmm, weekdayKey } from "./time";
import type { TimeConstraint } from "./text";
import { extractBusyBlocks } from "./freebusy";


export function subtractBusyFromWindow(opts: {
  windowStart: DateTime;
  windowEnd: DateTime;
  busy: Array<{ start: string; end: string }>;
  timeZone: string;
}): Array<{ start: DateTime; end: DateTime }> {
  const { windowStart, windowEnd, busy, timeZone } = opts;

  const busyBlocks = (busy || [])
    .map((b) => ({
      start: DateTime.fromISO(b.start, { zone: timeZone }),
      end: DateTime.fromISO(b.end, { zone: timeZone }),
    }))
    .filter((b) => b.start.isValid && b.end.isValid)
    .sort((a, b) => a.start.toMillis() - b.start.toMillis());

  const merged: Array<{ start: DateTime; end: DateTime }> = [];
  for (const b of busyBlocks) {
    const last = merged[merged.length - 1];
    if (!last) merged.push(b);
    else if (b.start <= last.end) last.end = DateTime.max(last.end, b.end);
    else merged.push(b);
  }

  let cursor = windowStart;
  const free: Array<{ start: DateTime; end: DateTime }> = [];

  for (const b of merged) {
    const bs = DateTime.max(b.start, windowStart);
    const be = DateTime.min(b.end, windowEnd);
    if (be <= windowStart || bs >= windowEnd) continue;

    if (bs > cursor) free.push({ start: cursor, end: bs });
    cursor = DateTime.max(cursor, be);
  }

  if (cursor < windowEnd) free.push({ start: cursor, end: windowEnd });

  return free;
}

export function sliceIntoSlots(opts: {
  freeRanges: Array<{ start: DateTime; end: DateTime }>;
  durationMin: number;
  bufferMin: number;
  timeZone: string;
  minLeadMinutes: number; // ✅ NUEVO (tenant)
}): Slot[] {
  const { freeRanges, durationMin, bufferMin, timeZone, minLeadMinutes } = opts;

  const lead = Number(minLeadMinutes);
  const safeLead = Number.isFinite(lead) && lead >= 0 ? lead : 0;

  const slots: Slot[] = [];
  const stepMin = Math.max(1, Number(durationMin || 0) + Number(bufferMin || 0));

  for (const r of freeRanges) {
    let start = r.start;

    // lead time
    const now = DateTime.now().setZone(timeZone).plus({ minutes: safeLead });
    if (start < now) start = now;

    start = start.set({ second: 0, millisecond: 0 });

    // ✅ redondea hacia arriba al "grid" del tenant: (duration + buffer)
    // Ej: duration=45, buffer=15 => step=60 => 9:00, 10:00, 11:00...
    const totalMin = start.hour * 60 + start.minute;
    const mod = totalMin % stepMin;
    if (mod !== 0) {
      start = start.plus({ minutes: stepMin - mod }).set({ second: 0, millisecond: 0 });
    }

    while (start.plus({ minutes: durationMin }) <= r.end) {
      const end = start.plus({ minutes: durationMin });

      // buffer: evita “pegar” slots (puedes ajustar o quitar)
      const endWithBuffer = end.plus({ minutes: bufferMin });
      if (endWithBuffer <= r.end) {
        const sISO = start.toISO();
        const eISO = end.toISO();
        if (sISO && eISO) slots.push({ startISO: sISO, endISO: eISO });
      }

      // ✅ siguiente inicio permitido: duración + buffer (por tenant)
      start = start.plus({ minutes: stepMin });
    }
  }

  return slots;
}

export function daypartWindowFromBusinessHours(opts: {
  day: DateTime;
  bizStart: DateTime;
  bizEnd: DateTime;
  daypart: "morning" | "afternoon";
}) {
  const { day, bizStart, bizEnd, daypart } = opts;

  const noon = day.set({ hour: 12, minute: 0, second: 0, millisecond: 0 });

  const start = daypart === "morning" ? bizStart : DateTime.max(bizStart, noon);
  const end = daypart === "morning" ? DateTime.min(bizEnd, noon) : bizEnd;

  if (!start.isValid || !end.isValid || end <= start) return null;
  return { start, end };
}

export function intersectWindows(aStart: DateTime, aEnd: DateTime, bStart: DateTime, bEnd: DateTime) {
  const s = DateTime.max(aStart, bStart);
  const e = DateTime.min(aEnd, bEnd);
  if (!s.isValid || !e.isValid || e <= s) return null;
  return { start: s, end: e };
}

function toMinutes(hhmm: string) {
  const [h, m] = hhmm.split(":").map((x) => Number(x));
  return (h || 0) * 60 + (m || 0);
}

function slotStartMinutes(s: Slot, timeZone: string) {
  const dt = DateTime.fromISO(s.startISO, { zone: timeZone });
  if (!dt.isValid) return null;
  return dt.hour * 60 + dt.minute;
}

function applyTimeConstraintToSlots(opts: {
  slots: Slot[];
  timeZone: string;
  constraint?: TimeConstraint | null;
}) {
  const { slots, timeZone, constraint } = opts;
  if (!constraint) return slots;

  if (constraint.kind === "earliest") {
    // ya vienen ordenados cronológicamente normalmente
    return slots;
  }

  if (constraint.kind === "any_morning") {
    return slots.filter((s) => {
      const m = slotStartMinutes(s, timeZone);
      return m !== null && m < 12 * 60;
    });
  }

  if (constraint.kind === "any_afternoon") {
    return slots.filter((s) => {
      const m = slotStartMinutes(s, timeZone);
      return m !== null && m >= 12 * 60;
    });
  }

  if (constraint.kind === "after") {
    const min = toMinutes(constraint.hhmm);
    return slots.filter((s) => {
      const m = slotStartMinutes(s, timeZone);
      return m !== null && m >= min;
    });
  }

  if (constraint.kind === "before") {
    const min = toMinutes(constraint.hhmm);
    return slots.filter((s) => {
      const m = slotStartMinutes(s, timeZone);
      return m !== null && m <= min;
    });
  }

  if (constraint.kind === "around") {
    const target = toMinutes(constraint.hhmm);
    const window = 90; // minutos +/- alrededor de la hora pedida
    return slots
      .map((s) => {
        const m = slotStartMinutes(s, timeZone);
        if (m === null) return null;
        return { s, d: Math.abs(m - target) };
      })
      .filter(Boolean)
      .filter((x: any) => x.d <= window)
      .sort((a: any, b: any) => a.d - b.d)
      .map((x: any) => x.s);
  }

  return slots;
}

export async function getSlotsForDate(opts: {
  tenantId: string;
  timeZone: string;
  dateISO: string; // "YYYY-MM-DD"
  durationMin: number;
  bufferMin: number;
  hours: HoursByWeekday | null;
  minLeadMinutes: number;
  calendarId?: string; 
}): Promise<Slot[]> {
  const { tenantId, timeZone, dateISO, durationMin, bufferMin, hours, minLeadMinutes } = opts;

  const lead = Number(minLeadMinutes);
  const safeLead = Number.isFinite(lead) && lead >= 0 ? lead : 0;

  const day = DateTime.fromFormat(dateISO, "yyyy-MM-dd", { zone: timeZone });
  if (!hours) return [];
  if (!day.isValid) return [];

  const key = weekdayKey(day);
  const dayHours = hours?.[key];
  if (!dayHours || !dayHours.start || !dayHours.end) return [];

  const st = parseHHmm(dayHours.start);
  const en = parseHHmm(dayHours.end);
  if (!st || !en) return [];

  let windowStart = day.set({ hour: st.h, minute: st.min, second: 0, millisecond: 0 });
  const windowEnd = day.set({ hour: en.h, minute: en.min, second: 0, millisecond: 0 });

  // ✅ Si es hoy, no ofrezcas slots antes de (ahora + lead time)
  const nowLead = DateTime.now().setZone(timeZone).plus({ minutes: safeLead });
  if (windowStart < nowLead && nowLead < windowEnd) {
    // mueve el inicio de la ventana al lead time
    // (mantiene el mismo día y respeta horario)
    (windowStart as any) = nowLead.set({ second: 0, millisecond: 0 });
  }

  if (!windowStart.isValid || !windowEnd.isValid || windowEnd <= windowStart) return [];

  const calendarId = opts.calendarId || "primary";

  const fb = await googleFreeBusy({
    tenantId,
    timeMin: windowStart.toISO()!,
    timeMax: windowEnd.toISO()!,
    calendarId,
  });

  const busy = extractBusyBlocks(fb, calendarId);
    console.log("🧪 getSlotsForDate busy:", {
    tenantId,
    calendarId,
    dateISO,
    timeMin: windowStart.toISO(),
    timeMax: windowEnd.toISO(),
    busyCount: busy.length,
    sample: busy[0] || null,
  });

  const freeRanges = subtractBusyFromWindow({
    windowStart,
    windowEnd,
    busy,
    timeZone,
  });

  const slots = sliceIntoSlots({
    freeRanges,
    durationMin,
    bufferMin,
    timeZone,
    minLeadMinutes: safeLead,
  });

  return slots; // NO cortes aquí
}

export async function getSlotsForDateWithConstraint(opts: {
  tenantId: string;
  timeZone: string;
  dateISO: string; // YYYY-MM-DD
  durationMin: number;
  bufferMin: number;
  hours: HoursByWeekday | null;
  minLeadMinutes: number;
  constraint?: TimeConstraint | null;
  limit?: number;
}): Promise<Slot[]> {
  const base = await getSlotsForDate({
    tenantId: opts.tenantId,
    timeZone: opts.timeZone,
    dateISO: opts.dateISO,
    durationMin: opts.durationMin,
    bufferMin: opts.bufferMin,
    hours: opts.hours,
    minLeadMinutes: opts.minLeadMinutes,
  });

  const filtered = applyTimeConstraintToSlots({
    slots: base,
    timeZone: opts.timeZone,
    constraint: opts.constraint,
  });

  const limit = opts.limit ?? 5;
  return filtered.slice(0, limit);
}

export async function getNextSlotsByDaypart(opts: {
  tenantId: string;
  timeZone: string;
  durationMin: number;
  bufferMin: number;
  hours: HoursByWeekday | null;
  minLeadMinutes: number;
  daypart: "morning" | "afternoon";
  daysAhead?: number;
  afterISO?: string | null;
}): Promise<Slot[]> {
  const { tenantId, timeZone, durationMin, bufferMin, hours, daypart } = opts;
  const daysAhead = opts.daysAhead ?? 7;

  const lead = Number(opts.minLeadMinutes);
  const safeLead = Number.isFinite(lead) && lead >= 0 ? lead : 0;

  if (!hours) return [];

  const out: Slot[] = [];

  const after = opts.afterISO
    ? DateTime.fromISO(opts.afterISO, { zone: timeZone })
    : null;

  const now = DateTime.now().setZone(timeZone);

  // si hay afterISO, empieza desde ese mismo día (pero en "now" no en 00:00)
  // si no hay afterISO, empieza desde hoy
  const startDay = (after && after.isValid)
    ? after.setZone(timeZone).startOf("day")
    : now.startOf("day");

  for (let i = 0; i < daysAhead; i++) {
    const day = startDay.plus({ days: i });

    const key = weekdayKey(day);
    const dayHours = hours?.[key];
    if (!dayHours || !dayHours.start || !dayHours.end) continue;

    const st = parseHHmm(dayHours.start);
    const en = parseHHmm(dayHours.end);
    if (!st || !en) continue;

    const bizStart = day.set({ hour: st.h, minute: st.min, second: 0, millisecond: 0 });
    const bizEnd = day.set({ hour: en.h, minute: en.min, second: 0, millisecond: 0 });
    if (bizEnd <= bizStart) continue;

    const win = daypartWindowFromBusinessHours({ day, bizStart, bizEnd, daypart });
    if (!win) continue;

    const calendarId = "primary";

    const fb = await googleFreeBusy({
      tenantId,
      timeMin: win.start.toISO()!,
      timeMax: win.end.toISO()!,
      calendarId,
    });

    const busy = extractBusyBlocks(fb, calendarId);
    
    const freeRanges = subtractBusyFromWindow({
      windowStart: win.start,
      windowEnd: win.end,
      busy,
      timeZone,
    });

    const slots = sliceIntoSlots({
      freeRanges,
      durationMin,
      bufferMin,
      timeZone,
      minLeadMinutes: safeLead,
    });

    for (const s of slots) {
      if (after) {
        const sdt = DateTime.fromISO(s.startISO, { zone: timeZone });
        if (!sdt.isValid) continue;
        if (sdt <= after) continue;
      }

      out.push(s);
      if (out.length >= 5) return out;
    }
  }

  return out.slice(0, 5);
}

export async function isRangeBusy(opts: {
  tenantId: string;
  timeMinISO: string;
  timeMaxISO: string;
  calendarId?: string;
}) {
  const calendarId = opts.calendarId || "primary";

  const fb = await googleFreeBusy({
    tenantId: opts.tenantId,
    timeMin: opts.timeMinISO,
    timeMax: opts.timeMaxISO,
    calendarId,
  });

  const busy = extractBusyBlocks(fb, calendarId);
  
  return { busy, isBusy: busy.length > 0 };
}

export async function getSlotsForDateWindow(opts: {
  tenantId: string;
  timeZone: string;
  dateISO: string; // "YYYY-MM-DD"
  durationMin: number;
  bufferMin: number;
  hours: HoursByWeekday | null;
  minLeadMinutes: number;
  calendarId?: string; // ✅ NUEVO

  // NUEVO: ventana dentro del día (HH:mm)
  windowStartHHmm: string; // "17:00"
  windowEndHHmm: string;   // "20:00"
}): Promise<Slot[]> {
  const { tenantId, timeZone, dateISO, durationMin, bufferMin, hours, windowStartHHmm, windowEndHHmm, minLeadMinutes } = opts;

  const lead = Number(minLeadMinutes);
  const safeLead = Number.isFinite(lead) && lead >= 0 ? lead : 0;

  const day = DateTime.fromFormat(dateISO, "yyyy-MM-dd", { zone: timeZone });
  if (!hours) return [];
  if (!day.isValid) return [];

  const key = weekdayKey(day);
  const dayHours = hours?.[key];
  if (!dayHours || !dayHours.start || !dayHours.end) return [];

  const businessSt = parseHHmm(dayHours.start);
  const businessEn = parseHHmm(dayHours.end);
  const winSt = parseHHmm(windowStartHHmm);
  const winEn = parseHHmm(windowEndHHmm);
  if (!businessSt || !businessEn || !winSt || !winEn) return [];

  // Ventana pedida
  let windowStart = day.set({ hour: winSt.h, minute: winSt.min, second: 0, millisecond: 0 });
  let windowEnd = day.set({ hour: winEn.h, minute: winEn.min, second: 0, millisecond: 0 });

  // Clip al horario del negocio (no salirse)
  const businessStart = day.set({ hour: businessSt.h, minute: businessSt.min, second: 0, millisecond: 0 });
  const businessEnd = day.set({ hour: businessEn.h, minute: businessEn.min, second: 0, millisecond: 0 });

  if (windowStart < businessStart) windowStart = businessStart;
  if (windowEnd > businessEnd) windowEnd = businessEnd;

  // Lead time si es hoy
  const nowLead = DateTime.now().setZone(timeZone).plus({ minutes: safeLead });
  if (windowStart < nowLead && nowLead < windowEnd) {
    (windowStart as any) = nowLead.set({ second: 0, millisecond: 0 });
  }

  if (!windowStart.isValid || !windowEnd.isValid || windowEnd <= windowStart) return [];

  const calendarId = opts.calendarId || "primary";

  const fb = await googleFreeBusy({
    tenantId,
    timeMin: windowStart.toISO()!,
    timeMax: windowEnd.toISO()!,
    calendarId,
  });

  const busy = extractBusyBlocks(fb, calendarId);
    console.log("🧪 getSlotsForDate busy:", {
    tenantId,
    calendarId,
    dateISO,
    timeMin: windowStart.toISO(),
    timeMax: windowEnd.toISO(),
    busyCount: busy.length,
    sample: busy[0] || null,
  });

  const freeRanges = subtractBusyFromWindow({
    windowStart,
    windowEnd,
    busy,
    timeZone,
  });

  const slots = sliceIntoSlots({
    freeRanges,
    durationMin,
    bufferMin,
    timeZone,
    minLeadMinutes: safeLead,
  });

  return slots;
}

export async function validateSlotStillFree(opts: {
  tenantId: string;
  calendarId?: string;
  slot: Slot;
}): Promise<boolean> {
  const calendarId = opts.calendarId || "primary";

  const { isBusy } = await isRangeBusy({
    tenantId: opts.tenantId,
    timeMinISO: opts.slot.startISO,
    timeMaxISO: opts.slot.endISO,
    calendarId,
  });

  return !isBusy;
}
