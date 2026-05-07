//src/lib/appointments/resolveVoiceScheduleValidation.ts
import { parseVoiceRequestedDate } from "./parseVoiceRequestedDate";
import { validateServiceScheduleForDate } from "./validateServiceScheduleForDate";

type ResolveVoiceScheduleValidationParams = {
  tenantId: string;
  serviceName: string;
  rawDatetime: string;
  channel?: string;
  baseDate?: Date;
  timeZone?: string;
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

export async function resolveVoiceScheduleValidation(
  params: ResolveVoiceScheduleValidationParams
): Promise<ResolveVoiceScheduleValidationResult> {
  const timeZone = String(params.timeZone || "America/New_York").trim() || "America/New_York";

  const parsed = parseVoiceRequestedDate({
    raw: params.rawDatetime,
    baseDate: params.baseDate,
    timeZone,
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

  const scheduleValidation = await validateServiceScheduleForDate({
    tenantId: params.tenantId,
    serviceName: params.serviceName,
    requestedAt: parsed.requestedAt,
    channel: params.channel || "voice",
    timeZone,
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

    const suggestedStarts = normalizeSuggestedStarts(
      (scheduleValidation as { suggestedStarts?: unknown }).suggestedStarts
    );

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