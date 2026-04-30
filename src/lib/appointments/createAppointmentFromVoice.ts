//src/lib/appointments/createAppointmentFromVoice.ts
import pool from "../db";
import { resolveVoiceScheduleValidation } from "./resolveVoiceScheduleValidation";

type AppointmentSettings = {
  default_duration_min: number;
  buffer_min: number;
  min_lead_minutes: number;
  timezone: string;
  enabled: boolean;
};

type BookingSlot =
  | "service"
  | "datetime"
  | "customer_name"
  | "customer_phone"
  | "customer_email"
  | "confirmation";

type Args = {
  tenantId: string;
  answersBySlot: Partial<Record<BookingSlot, string>>;
  idempotencyKey?: string;
  settings: AppointmentSettings;
};

function getTimeZoneParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(date);

  const map = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  ) as Record<string, string>;

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = getTimeZoneParts(date, timeZone);

  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  return asIfUtc - date.getTime();
}

function zonedLocalDateTimeToUtcDate(params: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
  timeZone: string;
}) {
  const {
    year,
    month,
    day,
    hour,
    minute,
    second = 0,
    timeZone,
  } = params;

  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstGuessDate = new Date(utcGuess);

  const firstOffset = getTimeZoneOffsetMs(firstGuessDate, timeZone);
  let correctedTs = utcGuess - firstOffset;

  const correctedDate = new Date(correctedTs);
  const secondOffset = getTimeZoneOffsetMs(correctedDate, timeZone);

  if (secondOffset !== firstOffset) {
    correctedTs = utcGuess - secondOffset;
  }

  return new Date(correctedTs);
}

function addDaysToYmd(
  year: number,
  month: number,
  day: number,
  daysToAdd: number
) {
  const base = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + daysToAdd);

  return {
    year: base.getUTCFullYear(),
    month: base.getUTCMonth() + 1,
    day: base.getUTCDate(),
  };
}

function parseVoiceDatetime(input: string, timeZone: string): Date | null {
  const raw = (input || "").trim().toLowerCase();
  if (!raw) return null;

  const nowInTz = getTimeZoneParts(new Date(), timeZone);

  let targetDate = {
    year: nowInTz.year,
    month: nowInTz.month,
    day: nowInTz.day,
  };

  if (raw.includes("mañana") || raw.includes("tomorrow")) {
    targetDate = addDaysToYmd(
      targetDate.year,
      targetDate.month,
      targetDate.day,
      1
    );
  }

  const hourMatch = raw.match(/\b(\d{1,2})(?::(\d{2}))?\b/);
  if (!hourMatch) return null;

  let hour = Number(hourMatch[1]);
  const minute = hourMatch[2] ? Number(hourMatch[2]) : 0;

  const isMorning =
    raw.includes("am") ||
    raw.includes("a.m") ||
    /\bpor la mañana\b/.test(raw);

  const isAfternoon =
    raw.includes("pm") ||
    raw.includes("p.m") ||
    raw.includes("tarde") ||
    raw.includes("noche");

  if (isAfternoon && hour < 12) hour += 12;
  if (isMorning && hour === 12) hour = 0;

  if (hour > 23 || minute > 59) return null;

  const utcDate = zonedLocalDateTimeToUtcDate({
    year: targetDate.year,
    month: targetDate.month,
    day: targetDate.day,
    hour,
    minute,
    second: 0,
    timeZone,
  });

  return Number.isNaN(utcDate.getTime()) ? null : utcDate;
}

export async function createAppointmentFromVoice(args: Args) {
  const serviceName = String(args.answersBySlot.service || "").trim();
  const datetimeText = args.answersBySlot.datetime || "";
  const customerPhone = args.answersBySlot.customer_phone || null;
  const customerName = args.answersBySlot.customer_name || "Cliente Voz";
  const customerEmail = args.answersBySlot.customer_email || null;
  const timeZone =
    String(args.settings.timezone || "").trim() || "America/New_York";

  if (!serviceName) {
    throw new Error("MISSING_SERVICE");
  }

  if (!args.settings.enabled) {
    throw new Error("APPOINTMENTS_DISABLED");
  }

  const scheduleValidation = await resolveVoiceScheduleValidation({
    tenantId: args.tenantId,
    serviceName,
    rawDatetime: datetimeText,
    channel: "voice",
  });

  if (!scheduleValidation.ok) {
    if (scheduleValidation.reason === "invalid_datetime") {
      throw new Error(`INVALID_VOICE_DATETIME: ${datetimeText}`);
    }

    throw new Error(
      `VOICE_SCHEDULE_NOT_AVAILABLE:${serviceName}:${scheduleValidation.availableTimes.join(",")}`
    );
  }

  const start = scheduleValidation.requestedAt;

  const reparsedStart = parseVoiceDatetime(datetimeText, timeZone);
  if (!reparsedStart) {
    throw new Error(`INVALID_VOICE_DATETIME: ${datetimeText}`);
  }

  const duration = args.settings.default_duration_min;
  const end = new Date(start.getTime() + duration * 60 * 1000);

  const idempotencyKey =
    args.idempotencyKey ||
    `voice:${args.tenantId}:${customerPhone || "unknown"}:${start.toISOString()}`;

  const { rows } = await pool.query(
    `
    INSERT INTO appointments (
      tenant_id,
      service_id,
      channel,
      customer_name,
      customer_phone,
      customer_email,
      start_time,
      end_time,
      status,
      external_calendar_event_id,
      google_event_id,
      google_event_link,
      idempotency_key,
      error_reason,
      created_at,
      updated_at
    )
    VALUES (
      $1,
      NULL,
      'voice',
      $2,
      $3,
      $4,
      $5,
      $6,
      'confirmed',
      NULL,
      NULL,
      NULL,
      $7,
      NULL,
      NOW(),
      NOW()
    )
    ON CONFLICT (idempotency_key)
    DO UPDATE SET
      updated_at = NOW()
    RETURNING *
    `,
    [
      args.tenantId,
      customerName,
      customerPhone,
      customerEmail,
      start.toISOString(),
      end.toISOString(),
      idempotencyKey,
    ]
  );

  return rows[0];
}