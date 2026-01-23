// src/lib/appointments/booking/slots.ts
import { DateTime } from "luxon";
import { googleFreeBusy } from "../../../services/googleCalendar";
import type { GoogleFreeBusyResponse } from "../../../services/googleCalendar";
import type { HoursByWeekday, Slot } from "./types";
import { MIN_LEAD_MINUTES, parseHHmm, weekdayKey } from "./time";

export function extractBusyBlocks(fb: GoogleFreeBusyResponse | any): Array<{ start: string; end: string }> {
  if (!fb?.calendars) return [];
  const primary = fb.calendars.primary || fb.calendars["primary"];
  if (primary?.busy) return primary.busy;
  const anyCal = Object.values(fb.calendars)[0] as any;
  return Array.isArray(anyCal?.busy) ? anyCal.busy : [];
}

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
}): Slot[] {
  const { freeRanges, durationMin, bufferMin, timeZone } = opts;

  const slots: Slot[] = [];

  for (const r of freeRanges) {
    let start = r.start;

    // lead time
    const now = DateTime.now().setZone(timeZone).plus({ minutes: MIN_LEAD_MINUTES });
    if (start < now) start = now;

    start = start.set({ second: 0, millisecond: 0 });

    // ✅ redondea hacia arriba a múltiplos de 15 minutos
    const m = start.minute;
    const mod = m % 15;
    if (mod !== 0) {
      start = start.plus({ minutes: 15 - mod }).set({ second: 0, millisecond: 0 });
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

      // incrementos de 15 minutos
      start = start.plus({ minutes: 15 });
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

export async function getSlotsForDate(opts: {
  tenantId: string;
  timeZone: string;
  dateISO: string; // "YYYY-MM-DD"
  durationMin: number;
  bufferMin: number;
  hours: HoursByWeekday | null;
}): Promise<Slot[]> {
  const { tenantId, timeZone, dateISO, durationMin, bufferMin, hours } = opts;

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
  const nowLead = DateTime.now().setZone(timeZone).plus({ minutes: MIN_LEAD_MINUTES });
  if (windowStart < nowLead && nowLead < windowEnd) {
    // mueve el inicio de la ventana al lead time
    // (mantiene el mismo día y respeta horario)
    (windowStart as any) = nowLead.set({ second: 0, millisecond: 0 });
  }

  if (!windowStart.isValid || !windowEnd.isValid || windowEnd <= windowStart) return [];

  const fb: GoogleFreeBusyResponse = await googleFreeBusy({
    tenantId,
    timeMin: windowStart.toISO()!,
    timeMax: windowEnd.toISO()!,
    calendarId: "primary",
  });

  const busy = extractBusyBlocks(fb);

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
  });

  return slots.slice(0, 5);
}

export async function getNextSlotsByDaypart(opts: {
  tenantId: string;
  timeZone: string;
  durationMin: number;
  bufferMin: number;
  hours: HoursByWeekday | null;
  daypart: "morning" | "afternoon";
  daysAhead?: number;
  afterISO?: string | null;
}): Promise<Slot[]> {
  const { tenantId, timeZone, durationMin, bufferMin, hours, daypart } = opts;
  const daysAhead = opts.daysAhead ?? 7;

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

    const fb = await googleFreeBusy({
      tenantId,
      timeMin: win.start.toISO()!,
      timeMax: win.end.toISO()!,
      calendarId: "primary",
    });

    const busy = extractBusyBlocks(fb);

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
  const fb = await googleFreeBusy({
    tenantId: opts.tenantId,
    timeMin: opts.timeMinISO,
    timeMax: opts.timeMaxISO,
    calendarId: opts.calendarId || "primary",
  });
  const busy = extractBusyBlocks(fb);
  return { busy, isBusy: busy.length > 0 };
}
