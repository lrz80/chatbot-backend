//src/lib/appointments/parseVoiceRequestedDate.ts
type ParseVoiceRequestedDateParams = {
  raw: string;
  baseDate?: Date;
  timeZone?: string;
};

type ParseVoiceRequestedDateResult =
  | {
      ok: true;
      requestedAt: Date;
    }
  | {
      ok: false;
    };

const WEEKDAY_MAP: Record<string, number> = {
  // español
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  miércoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
  sábado: 6,

  // inglés
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

type TimeZoneDateParts = {
  year: number;
  month: number;
  day: number;
  weekday: number;
};

function normalizeText(value: string): string {
  return (value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s:.]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getDatePartsInTimeZone(date: Date, timeZone: string): TimeZoneDateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);

  const year = Number(parts.find((p) => p.type === "year")?.value || "0");
  const month = Number(parts.find((p) => p.type === "month")?.value || "0");
  const day = Number(parts.find((p) => p.type === "day")?.value || "0");
  const weekdayShort = parts.find((p) => p.type === "weekday")?.value || "";

  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    year,
    month,
    day,
    weekday: weekdayMap[weekdayShort],
  };
}

function addDaysToParts(
  parts: TimeZoneDateParts,
  days: number,
  timeZone: string
): TimeZoneDateParts {
  const utcBase = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0));
  utcBase.setUTCDate(utcBase.getUTCDate() + days);
  return getDatePartsInTimeZone(utcBase, timeZone);
}

function resolveTargetDateParts(
  text: string,
  baseDate: Date,
  timeZone: string
): TimeZoneDateParts | null {
  const normalized = normalizeText(text);
  const baseParts = getDatePartsInTimeZone(baseDate, timeZone);

  if (normalized.includes("hoy") || normalized.includes("today")) {
    return baseParts;
  }

  if (normalized.includes("manana") || normalized.includes("tomorrow")) {
    return addDaysToParts(baseParts, 1, timeZone);
  }

  for (const [label, weekday] of Object.entries(WEEKDAY_MAP)) {
    if (normalized.includes(label)) {
      let diff = weekday - baseParts.weekday;
      if (diff < 0) diff += 7;
      if (diff === 0) diff = 7;
      return addDaysToParts(baseParts, diff, timeZone);
    }
  }

  return null;
}

function parseHourMinute(text: string): { hour: number; minute: number } | null {
  const normalized = normalizeText(text);

  let hour: number | null = null;
  let minute = 0;

  const hhmmColon = normalized.match(/\b(\d{1,2}):(\d{2})\b/);
  if (hhmmColon) {
    hour = Number(hhmmColon[1]);
    minute = Number(hhmmColon[2]);
  }

  if (hour === null) {
    const hhmmWithY = normalized.match(/\b(\d{1,2})\s+y\s+(\d{1,2})\b/);
    if (hhmmWithY) {
      hour = Number(hhmmWithY[1]);
      minute = Number(hhmmWithY[2]);
    }
  }

  if (hour === null) {
    const hhmmLoose = normalized.match(/\b(\d{1,2})\s+(\d{2})\b/);
    if (hhmmLoose) {
      hour = Number(hhmmLoose[1]);
      minute = Number(hhmmLoose[2]);
    }
  }

  if (hour === null) {
    const onlyHour = normalized.match(/\b(\d{1,2})\b/);
    if (onlyHour) {
      hour = Number(onlyHour[1]);
      minute = 0;
    }
  }

  if (hour === null) return null;

  const compact = normalized
    .replace(/\ba\s*\.?\s*m\s*\.?\b/g, "am")
    .replace(/\bp\s*\.?\s*m\s*\.?\b/g, "pm");

  const isPM =
    compact.includes("pm") ||
    compact.includes("de la tarde") ||
    compact.includes("de la noche");

  const isAM =
    compact.includes("am") ||
    compact.includes("de la manana") ||
    compact.includes("de la mañana");

  if (isPM && hour < 12) {
    hour += 12;
  }

  if (isAM && hour === 12) {
    hour = 0;
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  return { hour, minute };
}

function buildDateInTimeZone(params: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): Date {
  const { year, month, day, hour, minute, timeZone } = params;

  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(utcGuess);

  const tzYear = Number(parts.find((p) => p.type === "year")?.value || "0");
  const tzMonth = Number(parts.find((p) => p.type === "month")?.value || "0");
  const tzDay = Number(parts.find((p) => p.type === "day")?.value || "0");
  const tzHour = Number(parts.find((p) => p.type === "hour")?.value || "0");
  const tzMinute = Number(parts.find((p) => p.type === "minute")?.value || "0");

  const desiredUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const observedUtcMs = Date.UTC(tzYear, tzMonth - 1, tzDay, tzHour, tzMinute, 0, 0);

  const diffMs = desiredUtcMs - observedUtcMs;

  return new Date(utcGuess.getTime() + diffMs);
}

export function parseVoiceRequestedDate(
  params: ParseVoiceRequestedDateParams
): ParseVoiceRequestedDateResult {
  const baseDate = params.baseDate ? new Date(params.baseDate) : new Date();
  const raw = String(params.raw || "").trim();
  const timeZone = params.timeZone || "America/New_York";

  if (!raw) {
    return { ok: false };
  }

  const targetDateParts = resolveTargetDateParts(raw, baseDate, timeZone);
  const time = parseHourMinute(raw);

  if (!targetDateParts || !time) {
    return { ok: false };
  }

  const requestedAt = buildDateInTimeZone({
    year: targetDateParts.year,
    month: targetDateParts.month,
    day: targetDateParts.day,
    hour: time.hour,
    minute: time.minute,
    timeZone,
  });

  return {
    ok: true,
    requestedAt,
  };
}