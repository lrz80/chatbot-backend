// src/lib/appointments/parseVoiceRequestedDate.ts
type ParseVoiceRequestedDateParams = {
  raw: string;
  baseDate?: Date;
  timeZone?: string;
  referenceSuggestedStarts?: string[];
};

type ParseVoiceRequestedDateResult =
  | {
      ok: true;
      requestedAt: Date;
      hasExplicitDate: boolean;
      hasExplicitTime: boolean;
      confidence: "high" | "medium";
    }
  | {
      ok: false;
      hasExplicitDate: boolean;
      hasExplicitTime: boolean;
      confidence: "low";
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

  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const NUMBER_WORD_MAP: Record<string, number> = {
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,

  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

type TimeZoneDateParts = {
  year: number;
  month: number;
  day: number;
  weekday: number;
};

type DatetimeProtocolValue =
  | {
      status: "resolved";
      raw: string;

      /**
       * Canonical protocol preferred.
       * The model can understand any caller language, but the backend should
       * receive language-neutral values.
       */
      date_kind?: "today" | "tomorrow" | "weekday" | "calendar_date";
      weekday?: number; // 0 Sunday, 1 Monday, ... 6 Saturday
      date_iso?: string; // YYYY-MM-DD
      hour_24?: number; // 0-23
      minute?: number; // 0-59

      /**
       * Legacy fallback. Kept so old model responses still work.
       */
      date_text?: string;
      time_text?: string;
    }
  | {
      status: "unknown";
      raw: string;
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

function tokenizeNormalizedText(value: string): string[] {
  const normalized = normalizeText(value);

  if (!normalized) {
    return [];
  }

  return normalized
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

function hasToken(tokens: string[], expected: string): boolean {
  return tokens.includes(expected);
}

function hasSpanishRelativeTomorrow(tokens: string[]): boolean {
  return tokens.some((token, index) => {
    if (token !== "manana") {
      return false;
    }

    const previousOne = tokens[index - 1] || "";
    const previousTwo = tokens[index - 2] || "";

    const isMorningPeriod =
      previousOne === "la" &&
      (previousTwo === "de" || previousTwo === "por" || previousTwo === "en");

    return !isMorningPeriod;
  });
}

function replaceHourWordsWithDigits(value: string): string {
  const tokens = tokenizeNormalizedText(value);

  return tokens
    .map((token) => {
      const mappedNumber = NUMBER_WORD_MAP[token];

      return typeof mappedNumber === "number" ? String(mappedNumber) : token;
    })
    .join(" ");
}

function parseDatetimeProtocolValue(raw: string): DatetimeProtocolValue | null {
  const value = String(raw || "").trim();

  if (!value.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const status = String((parsed as any).status || "").trim().toLowerCase();
    const rawText = String((parsed as any).raw || "").trim();

    if (status === "unknown") {
      return {
        status: "unknown",
        raw: rawText,
      };
    }

    if (status !== "resolved") {
      return null;
    }

    const dateKindRaw = String((parsed as any).date_kind || "")
      .trim()
      .toLowerCase();

    const allowedDateKinds = new Set([
      "today",
      "tomorrow",
      "weekday",
      "calendar_date",
    ]);

    const dateKind = allowedDateKinds.has(dateKindRaw)
      ? (dateKindRaw as "today" | "tomorrow" | "weekday" | "calendar_date")
      : undefined;

    const weekdayRaw = (parsed as any).weekday;
    const weekday =
      typeof weekdayRaw === "number" && Number.isInteger(weekdayRaw)
        ? weekdayRaw
        : undefined;

    const dateIso = String((parsed as any).date_iso || "").trim();

    const hourRaw = (parsed as any).hour_24;
    const minuteRaw = (parsed as any).minute;

    const hour24 =
      typeof hourRaw === "number" && Number.isInteger(hourRaw)
        ? hourRaw
        : undefined;

    const minute =
      typeof minuteRaw === "number" && Number.isInteger(minuteRaw)
        ? minuteRaw
        : undefined;

    const hasCanonicalTime =
      typeof hour24 === "number" &&
      hour24 >= 0 &&
      hour24 <= 23 &&
      typeof minute === "number" &&
      minute >= 0 &&
      minute <= 59;

    const hasCanonicalDate =
      dateKind === "today" ||
      dateKind === "tomorrow" ||
      (dateKind === "weekday" &&
        typeof weekday === "number" &&
        weekday >= 0 &&
        weekday <= 6) ||
      (dateKind === "calendar_date" && /^\d{4}-\d{2}-\d{2}$/.test(dateIso));

    if (hasCanonicalDate && hasCanonicalTime) {
      return {
        status: "resolved",
        raw: rawText,
        date_kind: dateKind,
        weekday,
        date_iso: dateIso || undefined,
        hour_24: hour24,
        minute,
      };
    }

    /**
     * Legacy fallback for old model responses:
     * {"status":"resolved","raw":"...","date_text":"...","time_text":"..."}
     */
    const dateText = String((parsed as any).date_text || "").trim();
    const timeText = String((parsed as any).time_text || "").trim();

    if (!dateText || !timeText) {
      return {
        status: "unknown",
        raw: rawText,
      };
    }

    return {
      status: "resolved",
      raw: rawText,
      date_text: dateText,
      time_text: timeText,
    };
  } catch {
    return null;
  }
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
  const utcBase = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0)
  );

  utcBase.setUTCDate(utcBase.getUTCDate() + days);

  return getDatePartsInTimeZone(utcBase, timeZone);
}

function resolveCanonicalDateParts(
  protocolValue: DatetimeProtocolValue,
  baseDate: Date,
  timeZone: string
): TimeZoneDateParts | null {
  if (protocolValue.status !== "resolved") {
    return null;
  }

  const baseParts = getDatePartsInTimeZone(baseDate, timeZone);

  if (protocolValue.date_kind === "today") {
    return baseParts;
  }

  if (protocolValue.date_kind === "tomorrow") {
    return addDaysToParts(baseParts, 1, timeZone);
  }

  if (
    protocolValue.date_kind === "weekday" &&
    typeof protocolValue.weekday === "number" &&
    protocolValue.weekday >= 0 &&
    protocolValue.weekday <= 6
  ) {
    let diff = protocolValue.weekday - baseParts.weekday;

    if (diff <= 0) {
      diff += 7;
    }

    return addDaysToParts(baseParts, diff, timeZone);
  }

  if (
    protocolValue.date_kind === "calendar_date" &&
    protocolValue.date_iso &&
    /^\d{4}-\d{2}-\d{2}$/.test(protocolValue.date_iso)
  ) {
    const [year, month, day] = protocolValue.date_iso
      .split("-")
      .map((part) => Number(part));

    if (
      Number.isInteger(year) &&
      Number.isInteger(month) &&
      Number.isInteger(day) &&
      year >= 2000 &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= 31
    ) {
      const utcDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
      return getDatePartsInTimeZone(utcDate, timeZone);
    }
  }

  return null;
}

function resolveCanonicalTime(
  protocolValue: DatetimeProtocolValue
): { hour: number; minute: number } | null {
  if (protocolValue.status !== "resolved") {
    return null;
  }

  const hour = protocolValue.hour_24;
  const minute = protocolValue.minute;

  if (
    typeof hour !== "number" ||
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    typeof minute !== "number" ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return {
    hour,
    minute,
  };
}

function resolveTargetDateParts(
  text: string,
  baseDate: Date,
  timeZone: string
): TimeZoneDateParts | null {
  const tokens = tokenizeNormalizedText(text);
  const baseParts = getDatePartsInTimeZone(baseDate, timeZone);

  if (hasToken(tokens, "hoy") || hasToken(tokens, "today")) {
    return baseParts;
  }

  const hasRelativeTomorrow =
    hasToken(tokens, "tomorrow") || hasSpanishRelativeTomorrow(tokens);

  if (hasRelativeTomorrow) {
    return addDaysToParts(baseParts, 1, timeZone);
  }

  for (const [label, weekday] of Object.entries(WEEKDAY_MAP)) {
    const matchesWeekday = hasToken(tokens, normalizeText(label));

    if (!matchesWeekday) {
      continue;
    }

    let diff = weekday - baseParts.weekday;

    if (diff <= 0) {
      diff += 7;
    }

    return addDaysToParts(baseParts, diff, timeZone);
  }

  return null;
}

function parseHourMinute(text: string): { hour: number; minute: number } | null {
  const normalized = replaceHourWordsWithDigits(text);

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
  const observedUtcMs = Date.UTC(
    tzYear,
    tzMonth - 1,
    tzDay,
    tzHour,
    tzMinute,
    0,
    0
  );

  const diffMs = desiredUtcMs - observedUtcMs;

  return new Date(utcGuess.getTime() + diffMs);
}

function resolveSuggestedStartByTime(params: {
  referenceSuggestedStarts: string[];
  raw: string;
  timeZone: string;
}): Date | null {
  const requestedTime = parseHourMinute(params.raw);

  if (!requestedTime) {
    return null;
  }

  const candidates = params.referenceSuggestedStarts
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()))
    .filter((date) => {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: params.timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(date);

      const hour = Number(parts.find((p) => p.type === "hour")?.value || "0");
      const minute = Number(parts.find((p) => p.type === "minute")?.value || "0");

      return hour === requestedTime.hour && minute === requestedTime.minute;
    });

  if (candidates.length !== 1) {
    return null;
  }

  return candidates[0];
}

export function hasExplicitVoiceDateAnchor(params: {
  raw: string;
  baseDate?: Date;
  timeZone?: string;
}): boolean {
  const raw = String(params.raw || "").trim();

  if (!raw) {
    return false;
  }

  const protocolValue = parseDatetimeProtocolValue(raw);

  if (protocolValue?.status === "resolved") {
    const baseDate = params.baseDate ? new Date(params.baseDate) : new Date();
    const timeZone = params.timeZone || "America/New_York";

    return Boolean(resolveCanonicalDateParts(protocolValue, baseDate, timeZone)) ||
      Boolean(protocolValue.date_text);
  }

  const baseDate = params.baseDate ? new Date(params.baseDate) : new Date();
  const timeZone = params.timeZone || "America/New_York";

  return Boolean(resolveTargetDateParts(raw, baseDate, timeZone));
}

export function parseVoiceRequestedDate(
  params: ParseVoiceRequestedDateParams
): ParseVoiceRequestedDateResult {
  const baseDate = params.baseDate ? new Date(params.baseDate) : new Date();
  const raw = String(params.raw || "").trim();
  const timeZone = params.timeZone || "America/New_York";

  if (!raw) {
    return {
      ok: false,
      hasExplicitDate: false,
      hasExplicitTime: false,
      confidence: "low",
    };
  }

  const protocolValue = parseDatetimeProtocolValue(raw);

  if (protocolValue?.status === "unknown") {
    return {
      ok: false,
      hasExplicitDate: false,
      hasExplicitTime: false,
      confidence: "low",
    };
  }

  const canonicalDateParts =
    protocolValue?.status === "resolved"
      ? resolveCanonicalDateParts(protocolValue, baseDate, timeZone)
      : null;

  const canonicalTime =
    protocolValue?.status === "resolved"
      ? resolveCanonicalTime(protocolValue)
      : null;

  if (canonicalDateParts && canonicalTime) {
    const requestedAt = buildDateInTimeZone({
      year: canonicalDateParts.year,
      month: canonicalDateParts.month,
      day: canonicalDateParts.day,
      hour: canonicalTime.hour,
      minute: canonicalTime.minute,
      timeZone,
    });

    console.log("[VOICE][TARGET_DATE_PARTS]", {
      raw,
      effectiveRaw:
        protocolValue?.status === "resolved" ? protocolValue.raw : raw,
      baseDate: baseDate.toISOString(),
      timeZone,
      targetDateParts: canonicalDateParts,
      protocol: "canonical",
    });

    return {
      ok: true,
      requestedAt,
      hasExplicitDate: true,
      hasExplicitTime: true,
      confidence: "high",
    };
  }

  const effectiveRaw =
    protocolValue?.status === "resolved" &&
    protocolValue.date_text &&
    protocolValue.time_text
      ? `${protocolValue.date_text} ${protocolValue.time_text}`
      : raw;

  const targetDateParts = resolveTargetDateParts(
    effectiveRaw,
    baseDate,
    timeZone
  );

  console.log("[VOICE][TARGET_DATE_PARTS]", {
    raw,
    effectiveRaw,
    baseDate: baseDate.toISOString(),
    timeZone,
    targetDateParts,
  });

  const time = parseHourMinute(effectiveRaw);

  if (targetDateParts && time) {
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
      hasExplicitDate: true,
      hasExplicitTime: true,
      confidence: protocolValue?.status === "resolved" ? "high" : "medium",
    };
  }

  const suggestedMatch = resolveSuggestedStartByTime({
    referenceSuggestedStarts: Array.isArray(params.referenceSuggestedStarts)
      ? params.referenceSuggestedStarts
      : [],
    raw: effectiveRaw,
    timeZone,
  });

  if (suggestedMatch) {
    return {
      ok: true,
      requestedAt: suggestedMatch,
      hasExplicitDate: true,
      hasExplicitTime: true,
      confidence: "high",
    };
  }

  return {
    ok: false,
    hasExplicitDate: Boolean(targetDateParts),
    hasExplicitTime: Boolean(time),
    confidence: "low",
  };
}