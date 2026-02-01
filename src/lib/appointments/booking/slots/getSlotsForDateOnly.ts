import { DateTime } from "luxon";
import type { Slot } from "../types";           // ajusta si tu tipo Slot vive en otro lado
import type { HoursByWeekday } from "../types"; // ajusta si está en otro archivo

import { weekdayKey, parseHHmm } from "../time"; // ajusta imports según tu proyecto
import { googleFreeBusy } from "../../../../services/googleCalendar"; // ajusta ruta real
import { subtractBusyFromWindow, sliceIntoSlots } from "../slots";
import { extractBusyBlocks } from "../freebusy";

export async function getSlotsForDateOnly(opts: {
  tenantId: string;
  timeZone: string;
  durationMin: number;
  bufferMin: number;
  hours: HoursByWeekday | null;
  minLeadMinutes: number;
  dateOnly: string;      // yyyy-MM-dd
  afterISO?: string | null;
  calendarId?: string;
}): Promise<Slot[]> {
  const calendarId = opts.calendarId || "primary";

  const { tenantId, timeZone, durationMin, bufferMin, hours, dateOnly, minLeadMinutes } = opts;

  const lead = Number(minLeadMinutes);
  const safeLead = Number.isFinite(lead) && lead >= 0 ? lead : 0;

  if (!hours) return [];

  const after = opts.afterISO
    ? DateTime.fromISO(opts.afterISO, { zone: timeZone })
    : null;

  const day = DateTime.fromISO(dateOnly, { zone: timeZone }).startOf("day");
  if (!day.isValid) return [];

  const key = weekdayKey(day);
  const dayHours = hours?.[key];
  if (!dayHours || !dayHours.start || !dayHours.end) return [];

  const st = parseHHmm(dayHours.start);
  const en = parseHHmm(dayHours.end);
  if (!st || !en) return [];

  const bizStart = day.set({ hour: st.h, minute: st.min, second: 0, millisecond: 0 });
  const bizEnd = day.set({ hour: en.h, minute: en.min, second: 0, millisecond: 0 });
  if (bizEnd <= bizStart) return [];

  const fb = await googleFreeBusy({
    tenantId,
    timeMin: bizStart.toISO()!,
    timeMax: bizEnd.toISO()!,
    calendarIds: calendarId ? [calendarId] : ["primary"],
  });

  const busy = extractBusyBlocks(fb);
  console.log("🧪 getSlotsForDateOnly busy:", { tenantId, calendarId, dateOnly, busyCount: busy.length });

  const freeRanges = subtractBusyFromWindow({
    windowStart: bizStart,
    windowEnd: bizEnd,
    busy,
    timeZone,
  });

  const slots = sliceIntoSlots({
    freeRanges,
    durationMin,
    bufferMin,
    timeZone,
    minLeadMinutes: opts.minLeadMinutes,
  });

  const out: Slot[] = [];

  for (const s of slots) {
    if (after) {
      const sdt = DateTime.fromISO(s.startISO, { zone: timeZone });
      if (!sdt.isValid) continue;
      if (sdt <= after) continue;
    }

    out.push(s);
    if (out.length >= 5) break;
  }

  return out.slice(0, 3);
}
