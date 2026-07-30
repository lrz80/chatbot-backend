//src/lib/appointments/formatSuggestedStartsForVoice.ts
import type { VoiceLocale } from "../voice/types";

type LocalDateGroup = {
  date: Date;
  times: string[];
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function getLocalDateKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function formatSuggestedStartsForVoice(params: {
  starts: string[];
  locale: VoiceLocale;
  timeZone: string;
  referenceDate?: Date;
  limit?: number;
}): string {
  const locale = clean(params.locale) || "en-US";
  const timeZone = clean(params.timeZone);

  if (!timeZone) {
    throw new Error("SUGGESTED_STARTS_TIME_ZONE_MISSING");
  }

  const referenceDate = params.referenceDate || new Date();

  const limit =
    typeof params.limit === "number" && params.limit > 0
      ? Math.floor(params.limit)
      : 3;

  const todayKey = getLocalDateKey(referenceDate, timeZone);

  const tomorrow = new Date(
    referenceDate.getTime() + 24 * 60 * 60 * 1000
  );

  const tomorrowKey = getLocalDateKey(tomorrow, timeZone);

  const timeFormatter = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  });

  const weekdayFormatter = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "long",
  });

  const relativeDayFormatter = new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
  });

  const groups = new Map<string, LocalDateGroup>();

  for (const iso of params.starts.slice(0, limit)) {
    const date = new Date(iso);

    if (Number.isNaN(date.getTime())) {
      continue;
    }

    const dateKey = getLocalDateKey(date, timeZone);
    const timeText = timeFormatter.format(date);
    const existing = groups.get(dateKey);

    if (existing) {
      if (!existing.times.includes(timeText)) {
        existing.times.push(timeText);
      }

      continue;
    }

    groups.set(dateKey, {
      date,
      times: [timeText],
    });
  }

  const formattedGroups = Array.from(groups.entries()).map(
    ([dateKey, group]) => {
      const dayLabel =
        dateKey === todayKey
          ? relativeDayFormatter.format(0, "day")
          : dateKey === tomorrowKey
            ? relativeDayFormatter.format(1, "day")
            : weekdayFormatter.format(group.date);

      const timesText = new Intl.ListFormat(locale, {
        style: "long",
        type: "disjunction",
      }).format(group.times);

      return `${dayLabel}: ${timesText}`;
    }
  );

  return new Intl.ListFormat(locale, {
    style: "long",
    type: "disjunction",
  }).format(formattedGroups);
}