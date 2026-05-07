//src/lib/appointments/resolveVoiceScheduleValidation.ts
import pool from "../db";
import { parseVoiceRequestedDate } from "./parseVoiceRequestedDate";
import { validateServiceScheduleForDate } from "./validateServiceScheduleForDate";
import { BookingProviderOrchestrator } from "./booking/providers/orchestrator";

type ResolveVoiceScheduleValidationParams = {
  tenantId: string;
  serviceName: string;
  rawDatetime: string;
  channel?: string;
  baseDate?: Date;
  timeZone?: string;
  durationMin?: number;
  bufferMin?: number;
  referenceSuggestedStarts?: string[];
};

export type ResolveVoiceScheduleValidationResult =
  | {
      ok: true;
      requestedAt: Date;
      timeZone: string;
    }
  | {
      ok: false;
      reason: "invalid_datetime";
      availableTimes: [];
      suggestedStarts: [];
      timeZone: string;
    }
  | {
      ok: false;
      reason: "lead_time_not_met";
      availableTimes: [];
      suggestedStarts: string[];
      timeZone: string;
    }
  | {
      ok: false;
      reason: "schedule_not_available";
      availableTimes: string[];
      suggestedStarts: string[];
      timeZone: string;
    };

function dedupeStringArray(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

function normalizeSuggestedStarts(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return dedupeStringArray(
    input.filter((value): value is string => typeof value === "string")
  );
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

async function filterBookableSuggestedStarts(params: {
  tenantId: string;
  serviceName: string;
  candidateStarts: string[];
  durationMin: number;
  bufferMin: number;
  timeZone: string;
}): Promise<string[]> {
  const orchestrator = new BookingProviderOrchestrator();

  const uniqueCandidates = dedupeStringArray(params.candidateStarts);

  if (!uniqueCandidates.length) {
    return [];
  }

  const bookable: string[] = [];

  for (const startISO of uniqueCandidates) {
    const start = new Date(startISO);

    if (Number.isNaN(start.getTime())) {
      continue;
    }

    const end = addMinutes(start, params.durationMin);

    const availability = await orchestrator.checkAvailability({
      tenantId: params.tenantId,
      summary: params.serviceName,
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      timeZone: params.timeZone,
      bufferMin: params.bufferMin,
      calendarId: null,
    });

    if (availability.ok) {
      bookable.push(start.toISOString());
    }
  }

  return bookable;
}

export async function resolveVoiceScheduleValidation(
  params: ResolveVoiceScheduleValidationParams
): Promise<ResolveVoiceScheduleValidationResult> {
  const timeZone =
    String(params.timeZone || "America/New_York").trim() || "America/New_York";

  const parsed = parseVoiceRequestedDate({
    raw: params.rawDatetime,
    baseDate: params.baseDate,
    timeZone,
    referenceSuggestedStarts: params.referenceSuggestedStarts,
  });

  console.log("[VOICE][DATETIME_PARSE]", {
    tenantId: params.tenantId,
    serviceName: params.serviceName,
    rawDatetime: params.rawDatetime,
    timeZone,
    parsed,
  });

  if (!parsed.ok) {
    return {
      ok: false,
      reason: "invalid_datetime",
      availableTimes: [],
      suggestedStarts: [],
      timeZone,
    };
  }

  const { rows: settingsRows } = await pool.query(
    `
      SELECT
        min_lead_minutes,
        default_duration_min,
        buffer_min
      FROM appointment_settings
      WHERE tenant_id = $1
      LIMIT 1
    `,
    [params.tenantId]
  );

  const minLeadMinutesRaw = Number(settingsRows?.[0]?.min_lead_minutes ?? 0);
  const minLeadMinutes =
    Number.isFinite(minLeadMinutesRaw) && minLeadMinutesRaw > 0
      ? minLeadMinutesRaw
      : 0;

  const defaultDurationMinRaw = Number(
    settingsRows?.[0]?.default_duration_min ?? params.durationMin ?? 30
  );
  const defaultDurationMin =
    Number.isFinite(defaultDurationMinRaw) && defaultDurationMinRaw > 0
      ? defaultDurationMinRaw
      : 30;

  const bufferMinRaw = Number(
    settingsRows?.[0]?.buffer_min ?? params.bufferMin ?? 0
  );
  const bufferMin =
    Number.isFinite(bufferMinRaw) && bufferMinRaw >= 0
      ? bufferMinRaw
      : 0;

  if (minLeadMinutes > 0) {
    const earliestAllowedAt = addMinutes(
      params.baseDate instanceof Date ? params.baseDate : new Date(),
      minLeadMinutes
    );

    if (parsed.requestedAt.getTime() < earliestAllowedAt.getTime()) {
      const fallbackSuggestionValidation = await validateServiceScheduleForDate({
        tenantId: params.tenantId,
        serviceName: params.serviceName,
        requestedAt: earliestAllowedAt,
        channel: params.channel || "voice",
        timeZone,
        durationMin: defaultDurationMin,
        bufferMin,
        includeBufferInClosingBoundary: true,
      });

      const rawSuggestedStarts = normalizeSuggestedStarts(
        (fallbackSuggestionValidation as { suggestedStarts?: unknown })
          .suggestedStarts
      );

      const suggestedStarts = await filterBookableSuggestedStarts({
        tenantId: params.tenantId,
        serviceName: params.serviceName,
        candidateStarts: rawSuggestedStarts,
        durationMin: defaultDurationMin,
        bufferMin,
        timeZone,
      });

      return {
        ok: false,
        reason: "lead_time_not_met",
        availableTimes: [],
        suggestedStarts,
        timeZone,
      };
    }
  }

  const scheduleValidation = await validateServiceScheduleForDate({
    tenantId: params.tenantId,
    serviceName: params.serviceName,
    requestedAt: parsed.requestedAt,
    channel: params.channel || "voice",
    timeZone,
    durationMin: defaultDurationMin,
    bufferMin,
    includeBufferInClosingBoundary: true,
  });

  console.log("[VOICE][SCHEDULE_CHECK]", {
    tenantId: params.tenantId,
    serviceName: params.serviceName,
    requestedAt: parsed.requestedAt.toISOString(),
    channel: params.channel || "voice",
    timeZone,
    scheduleValidation,
  });

  if (!scheduleValidation.ok) {
    const availableTimes = dedupeStringArray(
      Array.isArray(scheduleValidation.availableTimes)
        ? scheduleValidation.availableTimes
        : []
    );

    const rawSuggestedStarts = normalizeSuggestedStarts(
      (scheduleValidation as { suggestedStarts?: unknown }).suggestedStarts
    );

    const suggestedStarts = await filterBookableSuggestedStarts({
      tenantId: params.tenantId,
      serviceName: params.serviceName,
      candidateStarts: rawSuggestedStarts,
      durationMin: defaultDurationMin,
      bufferMin,
      timeZone,
    });

    return {
      ok: false,
      reason: "schedule_not_available",
      availableTimes,
      suggestedStarts,
      timeZone,
    };
  }

  return {
    ok: true,
    requestedAt: parsed.requestedAt,
    timeZone,
  };
}