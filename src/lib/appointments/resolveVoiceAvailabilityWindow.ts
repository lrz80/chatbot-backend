// src/lib/appointments/resolveVoiceAvailabilityWindow.ts

import pool from "../db";
import { parseVoiceRequestedDate } from "./parseVoiceRequestedDate";
import { validateServiceScheduleForDate } from "./validateServiceScheduleForDate";
import { BookingProviderOrchestrator } from "./booking/providers/orchestrator";

type VoiceLocale = "en-US" | "es-ES" | "pt-BR";

type TimeWindowConfig = {
  labels?: Record<string, string[]>;
  start?: string;
  end?: string;
  available_prompt?: string | Record<string, string>;
  unavailable_prompt?: string | Record<string, string>;
};

type ResolveVoiceAvailabilityWindowParams = {
  tenantId: string;
  serviceName: string;
  raw: string;
  locale: VoiceLocale;
  channel?: string;
  baseDate?: Date;
  timeZone?: string | null;
  referenceRequestedAt?: string | null;
};

type ResolveVoiceAvailabilityWindowResult =
  | {
      kind: "not_window_request";
    }
  | {
      kind: "window_result";
      ok: boolean;
      windowKey: string;
      prompt: string;
      suggestedStarts: string[];
      referenceRequestedAtIso: string;
      timeZone: string;
    };

type TimeZoneDateParts = {
  year: number;
  month: number;
  day: number;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeText(value: unknown): string {
  return clean(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s:.]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasExplicitDateAnchor(value: unknown): boolean {
  const text = normalizeText(value);

  if (!text) {
    return false;
  }

  return Boolean(
    parseVoiceRequestedDate({
      raw: `${text} 12:00`,
      baseDate: new Date(),
      timeZone: "America/New_York",
    }).ok
  );
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};

  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }

  return {};
}

function getLocalizedString(
  value: unknown,
  locale: VoiceLocale
): string {
  if (typeof value === "string") {
    return clean(value);
  }

  const record = parseJsonObject(value);
  const shortLocale = locale.split("-")[0];

  return (
    clean(record[locale]) ||
    clean(record[shortLocale]) ||
    clean(record.default)
  );
}

function getLocalizedLabels(
  value: unknown,
  locale: VoiceLocale
): string[] {
  const record = parseJsonObject(value);
  const shortLocale = locale.split("-")[0];

  const rawLabels =
    record[locale] ||
    record[shortLocale] ||
    record.default ||
    [];

  if (!Array.isArray(rawLabels)) {
    return [];
  }

  return rawLabels.map(clean).filter(Boolean);
}

function labelMatchesRaw(params: {
  raw: string;
  labels: string[];
}): boolean {
  const rawText = ` ${normalizeText(params.raw)} `;

  return params.labels.some((label) => {
    const normalizedLabel = ` ${normalizeText(label)} `;
    return normalizedLabel.trim() && rawText.includes(normalizedLabel);
  });
}

function parseHHMM(value: unknown): number | null {
  const match = clean(value).match(/^(\d{1,2}):(\d{2})$/);

  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return hour * 60 + minute;
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function getDatePartsInTimeZone(
  date: Date,
  timeZone: string
): TimeZoneDateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  return {
    year: Number(parts.find((p) => p.type === "year")?.value || "0"),
    month: Number(parts.find((p) => p.type === "month")?.value || "0"),
    day: Number(parts.find((p) => p.type === "day")?.value || "0"),
  };
}

function buildDateInTimeZone(params: {
  year: number;
  month: number;
  day: number;
  minuteOfDay: number;
  timeZone: string;
}): Date {
  const hour = Math.floor(params.minuteOfDay / 60);
  const minute = params.minuteOfDay % 60;

  const utcGuess = new Date(
    Date.UTC(params.year, params.month - 1, params.day, hour, minute, 0, 0)
  );

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: params.timeZone,
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

  const desiredUtcMs = Date.UTC(
    params.year,
    params.month - 1,
    params.day,
    hour,
    minute,
    0,
    0
  );

  const observedUtcMs = Date.UTC(
    tzYear,
    tzMonth - 1,
    tzDay,
    tzHour,
    tzMinute,
    0,
    0
  );

  return new Date(utcGuess.getTime() + (desiredUtcMs - observedUtcMs));
}

function resolveDatePartsForWindow(params: {
  raw: string;
  windowStart: string;
  baseDate: Date;
  timeZone: string;
  referenceRequestedAt?: string | null;
}): TimeZoneDateParts {
  const referenceDate = params.referenceRequestedAt
    ? new Date(params.referenceRequestedAt)
    : null;

  /**
   * Important:
   * In Realtime, the model can rewrite a vague follow-up like
   * "in the morning" into "Friday morning" based on previous suggestions.
   *
   * If we already have a reference datetime from the last rejected attempt,
   * that reference date must win for window-only follow-ups.
   */
  if (referenceDate && isValidDate(referenceDate)) {
    return getDatePartsInTimeZone(referenceDate, params.timeZone);
  }

  const parsedFromRaw = parseVoiceRequestedDate({
    raw: `${params.raw} ${params.windowStart}`,
    baseDate: params.baseDate,
    timeZone: params.timeZone,
  });

  if (parsedFromRaw.ok) {
    return getDatePartsInTimeZone(parsedFromRaw.requestedAt, params.timeZone);
  }

  return getDatePartsInTimeZone(params.baseDate, params.timeZone);
}

function formatSuggestedStarts(params: {
  starts: string[];
  locale: VoiceLocale;
  timeZone: string;
}): string {
  return params.starts
    .map((iso) => {
      const date = new Date(iso);

      if (Number.isNaN(date.getTime())) {
        return "";
      }

      return new Intl.DateTimeFormat(params.locale, {
        timeZone: params.timeZone,
        weekday: "long",
        hour: "numeric",
        minute: "2-digit",
      }).format(date);
    })
    .filter(Boolean)
    .join(", ");
}

function renderTemplate(
  template: string,
  values: Record<string, string>
): string {
  return clean(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    return values[key] ?? "";
  });
}

async function getBookableStarts(params: {
  tenantId: string;
  serviceName: string;
  channel: string;
  timeZone: string;
  durationMin: number;
  bufferMin: number;
  minLeadMinutes: number;
  dateParts: TimeZoneDateParts;
  windowStartMin: number;
  windowEndMin: number;
  incrementMin: number;
  maxSuggestions: number;
  baseDate: Date;
}): Promise<string[]> {
  const startedAt = Date.now();

  const orchestrator = new BookingProviderOrchestrator();
  const earliestAllowedAt = addMinutes(params.baseDate, params.minLeadMinutes);

  const candidateStarts: Date[] = [];

  for (
    let minuteOfDay = params.windowStartMin;
    minuteOfDay + params.durationMin <= params.windowEndMin;
    minuteOfDay += params.incrementMin
  ) {
    const start = buildDateInTimeZone({
      ...params.dateParts,
      minuteOfDay,
      timeZone: params.timeZone,
    });

    if (start.getTime() < earliestAllowedAt.getTime()) {
      continue;
    }

    candidateStarts.push(start);
  }

  const bookable: string[] = [];

  /**
   * Keep this conservative.
   * We want faster response than sequential checks, but we do not want to
   * overload Google Calendar/provider APIs or create noisy rate-limit issues.
   */
  const concurrency = 4;

  for (
    let batchStartIndex = 0;
    batchStartIndex < candidateStarts.length;
    batchStartIndex += concurrency
  ) {
    const batch = candidateStarts.slice(
      batchStartIndex,
      batchStartIndex + concurrency
    );

    const batchResults = await Promise.all(
      batch.map(async (start) => {
        const scheduleValidation = await validateServiceScheduleForDate({
          tenantId: params.tenantId,
          serviceName: params.serviceName,
          requestedAt: start,
          channel: params.channel,
          timeZone: params.timeZone,
          durationMin: params.durationMin,
          bufferMin: params.bufferMin,
          includeBufferInClosingBoundary: true,
        });

        if (!scheduleValidation.ok) {
          return null;
        }

        const end = addMinutes(start, params.durationMin);

        const providerAvailability = await orchestrator.checkAvailability({
          tenantId: params.tenantId,
          summary: params.serviceName,
          startISO: start.toISOString(),
          endISO: end.toISOString(),
          timeZone: params.timeZone,
          bufferMin: params.bufferMin,
          calendarId: null,
        });

        if (!providerAvailability.ok) {
          return null;
        }

        return start.toISOString();
      })
    );

    for (const startISO of batchResults) {
      if (!startISO) {
        continue;
      }

      bookable.push(startISO);

      if (bookable.length >= params.maxSuggestions) {
        console.log("[VOICE][AVAILABILITY_WINDOW_FAST_RESULT]", {
          tenantId: params.tenantId,
          serviceName: params.serviceName,
          checkedCandidates: Math.min(
            batchStartIndex + concurrency,
            candidateStarts.length
          ),
          totalCandidates: candidateStarts.length,
          found: bookable.length,
          durationMs: Date.now() - startedAt,
        });

        return bookable;
      }
    }
  }

  console.log("[VOICE][AVAILABILITY_WINDOW_RESULT]", {
    tenantId: params.tenantId,
    serviceName: params.serviceName,
    checkedCandidates: candidateStarts.length,
    totalCandidates: candidateStarts.length,
    found: bookable.length,
    durationMs: Date.now() - startedAt,
  });

  return bookable;
}

export async function resolveVoiceAvailabilityWindow(
  params: ResolveVoiceAvailabilityWindowParams
): Promise<ResolveVoiceAvailabilityWindowResult> {
  const baseDate = params.baseDate ? new Date(params.baseDate) : new Date();

  const { rows } = await pool.query(
    `
      SELECT
        timezone,
        default_duration_min,
        buffer_min,
        min_lead_minutes,
        slot_increment_min,
        max_window_suggestions,
        time_windows
      FROM appointment_settings
      WHERE tenant_id = $1
      LIMIT 1
    `,
    [params.tenantId]
  );

  const settings = rows[0];

  if (!settings) {
    return { kind: "not_window_request" };
  }

  const timeZone =
    clean(params.timeZone) ||
    clean(settings.timezone) ||
    "America/New_York";

  const timeWindows = parseJsonObject(settings.time_windows);

  const matchedEntry = Object.entries(timeWindows).find(([, rawWindow]) => {
    const window = parseJsonObject(rawWindow) as TimeWindowConfig;
    const labels = getLocalizedLabels(window.labels, params.locale);

    return labelMatchesRaw({
      raw: params.raw,
      labels,
    });
  });

  if (!matchedEntry) {
    return { kind: "not_window_request" };
  }

  const [windowKey, rawWindowConfig] = matchedEntry;
  const windowConfig = parseJsonObject(rawWindowConfig) as TimeWindowConfig;

  const windowStartMin = parseHHMM(windowConfig.start);
  const windowEndMin = parseHHMM(windowConfig.end);

  if (
    windowStartMin === null ||
    windowEndMin === null ||
    windowEndMin <= windowStartMin
  ) {
    return { kind: "not_window_request" };
  }

  const durationMin = toPositiveInt(settings.default_duration_min, 30);
  const bufferMin = toPositiveInt(settings.buffer_min, 0);
  const minLeadMinutes = toPositiveInt(settings.min_lead_minutes, 0);
  const incrementMin = toPositiveInt(settings.slot_increment_min, 15);
  const maxSuggestions = toPositiveInt(settings.max_window_suggestions, 3);

  const dateParts = resolveDatePartsForWindow({
    raw: params.raw,
    windowStart: clean(windowConfig.start),
    baseDate,
    timeZone,
    referenceRequestedAt: params.referenceRequestedAt,
  });

  const referenceRequestedAt = buildDateInTimeZone({
    ...dateParts,
    minuteOfDay: windowStartMin,
    timeZone,
  });

  const suggestedStarts = await getBookableStarts({
    tenantId: params.tenantId,
    serviceName: params.serviceName,
    channel: params.channel || "voice",
    timeZone,
    durationMin,
    bufferMin,
    minLeadMinutes,
    dateParts,
    windowStartMin,
    windowEndMin,
    incrementMin,
    maxSuggestions,
    baseDate,
  });

  const suggestedTimesText = formatSuggestedStarts({
    starts: suggestedStarts,
    locale: params.locale,
    timeZone,
  });

  const promptTemplate = suggestedStarts.length
    ? getLocalizedString(windowConfig.available_prompt, params.locale)
    : getLocalizedString(windowConfig.unavailable_prompt, params.locale);

  const prompt = renderTemplate(promptTemplate, {
    requested_service: params.serviceName,
    service: params.serviceName,
    suggested_times: suggestedTimesText,
    window_key: windowKey,
  });

  console.log("[VOICE][AVAILABILITY_WINDOW]", {
    tenantId: params.tenantId,
    serviceName: params.serviceName,
    raw: params.raw,
    locale: params.locale,
    windowKey,
    timeZone,
    suggestedStarts,
  });

  return {
    kind: "window_result",
    ok: suggestedStarts.length > 0,
    windowKey,
    prompt,
    suggestedStarts,
    referenceRequestedAtIso: referenceRequestedAt.toISOString(),
    timeZone,
  };
}