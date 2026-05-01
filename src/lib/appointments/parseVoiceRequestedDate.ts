//src/lib/appointments/parseVoiceRequestedDate.ts
type ParseVoiceRequestedDateParams = {
  raw: string;
  baseDate?: Date;
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
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  miércoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
  sábado: 6,
};

function normalizeText(value: string): string {
  return (value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s:]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cloneDate(date: Date): Date {
  return new Date(date.getTime());
}

function addDays(date: Date, days: number): Date {
  const d = cloneDate(date);
  d.setDate(d.getDate() + days);
  return d;
}

function resolveTargetDate(text: string, baseDate: Date): Date | null {
  const normalized = normalizeText(text);

  if (normalized.includes("hoy")) {
    return cloneDate(baseDate);
  }

  if (normalized.includes("manana")) {
    return addDays(baseDate, 1);
  }

  for (const [label, weekday] of Object.entries(WEEKDAY_MAP)) {
    if (normalized.includes(label)) {
      const currentWeekday = baseDate.getDay();
      let diff = weekday - currentWeekday;
      if (diff < 0) diff += 7;
      if (diff === 0) diff = 7;
      return addDays(baseDate, diff);
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

  const isPM =
    normalized.includes("pm") ||
    normalized.includes("de la tarde") ||
    normalized.includes("de la noche");

  const isAM =
    normalized.includes("am") ||
    normalized.includes("de la manana") ||
    normalized.includes("de la mañana");

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

export function parseVoiceRequestedDate(
  params: ParseVoiceRequestedDateParams
): ParseVoiceRequestedDateResult {
  const baseDate = params.baseDate ? new Date(params.baseDate) : new Date();
  const raw = String(params.raw || "").trim();

  if (!raw) {
    return { ok: false };
  }

  const targetDate = resolveTargetDate(raw, baseDate);
  const time = parseHourMinute(raw);

  if (!targetDate || !time) {
    return { ok: false };
  }

  targetDate.setHours(time.hour, time.minute, 0, 0);

  return {
    ok: true,
    requestedAt: targetDate,
  };
}