// src/lib/appointments/booking/freebusy.ts

// src/lib/appointments/booking/freebusy.ts

export type BusyBlock = { start: string; end: string };

function mapBusy(arr: any[]): BusyBlock[] {
  return (arr || [])
    .filter((b: any) => b?.start && b?.end)
    .map((b: any) => ({ start: String(b.start), end: String(b.end) }));
}

export function extractBusyBlocks(fb: any, calendarId?: string): BusyBlock[] {
  // Si freeBusy está degradado, no confiar en "busy" vacío
  if (fb?.degraded) return [];

  const calendars = fb?.calendars;
  if (!calendars || typeof calendars !== "object") {
    const busy = fb?.busy;
    return Array.isArray(busy) ? mapBusy(busy) : [];
  }

  const getBusy = (key: string) => {
    const arr = calendars?.[key]?.busy;
    return Array.isArray(arr) ? mapBusy(arr) : null;
  };

  if (calendarId) {
    const b = getBusy(calendarId);
    if (b && b.length > 0) return b;
  }

  if (Object.prototype.hasOwnProperty.call(calendars, "primary")) {
    const b = getBusy("primary");
    if (b && b.length > 0) return b;
  }

  const keys = Object.keys(calendars);

  if (keys.length === 1) {
    const b = getBusy(keys[0]);
    if (b && b.length > 0) return b;
  }

  for (const key of keys) {
    const raw = calendars?.[key]?.busy;
    if (Array.isArray(raw) && raw.length > 0) return mapBusy(raw);
  }

  return [];
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? new Date(value.getTime()) : new Date(value);
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function rangesOverlap(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function isRangeBusy(params: {
  start: Date;
  end: Date;
  busyBlocks: BusyBlock[];
}): boolean {
  const { start, end, busyBlocks } = params;

  return busyBlocks.some((block) => {
    const busyStart = toDate(block.start);
    const busyEnd = toDate(block.end);

    if (Number.isNaN(busyStart.getTime()) || Number.isNaN(busyEnd.getTime())) {
      return false;
    }

    return rangesOverlap(start, end, busyStart, busyEnd);
  });
}

export function isRangeFree(params: {
  start: Date;
  durationMin: number;
  busyBlocks: BusyBlock[];
  bufferMin?: number;
}): boolean {
  const { start, durationMin, busyBlocks, bufferMin = 0 } = params;

  const effectiveStart = addMinutes(start, -Math.max(bufferMin, 0));
  const effectiveEnd = addMinutes(
    start,
    Math.max(durationMin, 0) + Math.max(bufferMin, 0)
  );

  return !isRangeBusy({
    start: effectiveStart,
    end: effectiveEnd,
    busyBlocks,
  });
}

export function findNearestAvailableStarts(params: {
  requestedAt: Date;
  busyBlocks: BusyBlock[];
  businessOpenAt: Date;
  businessCloseAt: Date;
  durationMin: number;
  bufferMin?: number;
  stepMin?: number;
  maxSuggestions?: number;
}): Date[] {
  const {
    requestedAt,
    busyBlocks,
    businessOpenAt,
    businessCloseAt,
    durationMin,
    bufferMin = 0,
    stepMin = 15,
    maxSuggestions = 3,
  } = params;

  if (
    Number.isNaN(requestedAt.getTime()) ||
    Number.isNaN(businessOpenAt.getTime()) ||
    Number.isNaN(businessCloseAt.getTime()) ||
    durationMin <= 0 ||
    stepMin <= 0 ||
    businessCloseAt <= businessOpenAt
  ) {
    return [];
  }

  const latestValidStart = addMinutes(businessCloseAt, -durationMin);
  if (latestValidStart < businessOpenAt) {
    return [];
  }

  const suggestions: Date[] = [];
  const seen = new Set<number>();

  const tryPush = (candidate: Date) => {
    if (candidate < businessOpenAt || candidate > latestValidStart) return;
    const key = candidate.getTime();
    if (seen.has(key)) return;

    if (
      isRangeFree({
        start: candidate,
        durationMin,
        busyBlocks,
        bufferMin,
      })
    ) {
      seen.add(key);
      suggestions.push(candidate);
    }
  };

  // Primero intenta la hora exacta pedida.
  tryPush(requestedAt);

  for (
    let offset = stepMin;
    suggestions.length < maxSuggestions &&
    (addMinutes(requestedAt, offset) <= latestValidStart ||
      addMinutes(requestedAt, -offset) >= businessOpenAt);
    offset += stepMin
  ) {
    const forward = addMinutes(requestedAt, offset);
    const backward = addMinutes(requestedAt, -offset);

    tryPush(forward);

    if (suggestions.length >= maxSuggestions) break;

    tryPush(backward);
  }

  return suggestions
    .sort((a, b) => {
      const da = Math.abs(a.getTime() - requestedAt.getTime());
      const db = Math.abs(b.getTime() - requestedAt.getTime());
      return da - db;
    })
    .slice(0, maxSuggestions);
}