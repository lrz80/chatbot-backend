//src/lib/appointments/validateServiceScheduleForDate.ts
import { validateServiceSchedule } from "./validateServiceSchedule";

type ValidateServiceScheduleForDateParams = {
  tenantId: string;
  serviceName: string;
  requestedAt: Date;
  channel?: string;
  timeZone?: string;
};

type ValidateServiceScheduleForDateResult =
  | {
      ok: true;
      availableTimes: string[];
      suggestedStarts: string[];
    }
  | {
      ok: false;
      availableTimes: string[];
      suggestedStarts: string[];
    };

function getWeekdayInTimeZone(date: Date, timeZone: string): number {
  const weekdayShort = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(date);

  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return map[weekdayShort];
}

function getHHMMInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const hour = parts.find((p) => p.type === "hour")?.value || "00";
  const minute = parts.find((p) => p.type === "minute")?.value || "00";

  return `${hour}:${minute}`;
}

function getDatePartsInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((p) => p.type === "year")?.value || "1970";
  const month = parts.find((p) => p.type === "month")?.value || "01";
  const day = parts.find((p) => p.type === "day")?.value || "01";

  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
  };
}

function buildZonedDateFromParts(params: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): Date {
  const guessUtc = new Date(
    Date.UTC(params.year, params.month - 1, params.day, params.hour, params.minute, 0, 0)
  );

  const zonedParts = new Intl.DateTimeFormat("en-US", {
    timeZone: params.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(guessUtc);

  const zonedYear = Number(
    zonedParts.find((p) => p.type === "year")?.value || params.year
  );
  const zonedMonth = Number(
    zonedParts.find((p) => p.type === "month")?.value || params.month
  );
  const zonedDay = Number(
    zonedParts.find((p) => p.type === "day")?.value || params.day
  );
  const zonedHour = Number(
    zonedParts.find((p) => p.type === "hour")?.value || params.hour
  );
  const zonedMinute = Number(
    zonedParts.find((p) => p.type === "minute")?.value || params.minute
  );

  const desiredUtcMs = Date.UTC(
    params.year,
    params.month - 1,
    params.day,
    params.hour,
    params.minute,
    0,
    0
  );

  const actualAsUtcMs = Date.UTC(
    zonedYear,
    zonedMonth - 1,
    zonedDay,
    zonedHour,
    zonedMinute,
    0,
    0
  );

  return new Date(guessUtc.getTime() + (desiredUtcMs - actualAsUtcMs));
}

function addDaysKeepingTimeZoneBase(date: Date, days: number, timeZone: string): Date {
  const { year, month, day } = getDatePartsInTimeZone(date, timeZone);

  return buildZonedDateFromParts({
    year,
    month,
    day: day + days,
    hour: 0,
    minute: 0,
    timeZone,
  });
}

function parseHHMM(value: string): { hour: number; minute: number } | null {
  const raw = String(value || "").trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);

  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (
    Number.isNaN(hour) ||
    Number.isNaN(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return { hour, minute };
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

async function findSuggestedStarts(params: {
  tenantId: string;
  serviceName: string;
  requestedAt: Date;
  channel: string;
  timeZone: string;
  maxSuggestions: number;
  searchDays: number;
}): Promise<{ suggestedStarts: string[]; availableTimes: string[] }> {
  const suggestions: string[] = [];
  const availableTimesSeen: string[] = [];

  for (let offset = 0; offset < params.searchDays; offset += 1) {
    const dateForDay = addDaysKeepingTimeZoneBase(
      params.requestedAt,
      offset,
      params.timeZone
    );

    const dayOfWeek = getWeekdayInTimeZone(dateForDay, params.timeZone);

    const dayValidation = await validateServiceSchedule({
      tenantId: params.tenantId,
      serviceName: params.serviceName,
      dayOfWeek,
      timeHHMM: "00:00",
      channel: params.channel,
    });

    const rawDayAvailableTimes =
      "availableTimes" in dayValidation && Array.isArray(dayValidation.availableTimes)
        ? dayValidation.availableTimes
        : [];

    const dayAvailableTimes = dedupeStrings(rawDayAvailableTimes);

    if (!dayAvailableTimes.length) {
      continue;
    }

    for (const hhmm of dayAvailableTimes) {
      const parsedTime = parseHHMM(hhmm);
      if (!parsedTime) {
        continue;
      }

      const candidate = buildZonedDateFromParts({
        ...getDatePartsInTimeZone(dateForDay, params.timeZone),
        hour: parsedTime.hour,
        minute: parsedTime.minute,
        timeZone: params.timeZone,
      });

      if (candidate.getTime() < params.requestedAt.getTime()) {
        continue;
      }

      suggestions.push(candidate.toISOString());
      availableTimesSeen.push(hhmm);

      if (suggestions.length >= params.maxSuggestions) {
        return {
          suggestedStarts: dedupeStrings(suggestions),
          availableTimes: dedupeStrings(availableTimesSeen),
        };
      }
    }
  }

  return {
    suggestedStarts: dedupeStrings(suggestions),
    availableTimes: dedupeStrings(availableTimesSeen),
  };
}

export async function validateServiceScheduleForDate(
  params: ValidateServiceScheduleForDateParams
): Promise<ValidateServiceScheduleForDateResult> {
  const timeZone = String(params.timeZone || "America/New_York").trim() || "America/New_York";
  const channel = params.channel || "voice";

  const dayOfWeek = getWeekdayInTimeZone(params.requestedAt, timeZone);
  const timeHHMM = getHHMMInTimeZone(params.requestedAt, timeZone);

  const directValidation = await validateServiceSchedule({
    tenantId: params.tenantId,
    serviceName: params.serviceName,
    dayOfWeek,
    timeHHMM,
    channel,
  });

  if (directValidation.ok) {
    const directAvailableTimes =
      "availableTimes" in directValidation && Array.isArray(directValidation.availableTimes)
        ? directValidation.availableTimes
        : [];

    return {
      ok: true,
      availableTimes: dedupeStrings(directAvailableTimes),
      suggestedStarts: [],
    };
  }

  const suggestions = await findSuggestedStarts({
    tenantId: params.tenantId,
    serviceName: params.serviceName,
    requestedAt: params.requestedAt,
    channel,
    timeZone,
    maxSuggestions: 3,
    searchDays: 14,
  });

  return {
    ok: false,
    availableTimes: suggestions.availableTimes,
    suggestedStarts: suggestions.suggestedStarts,
  };
}