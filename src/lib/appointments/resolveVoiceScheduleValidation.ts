//src/lib/appointments/resolveVoiceScheduleValidation.ts
import { parseVoiceRequestedDate } from "./parseVoiceRequestedDate";
import { validateServiceScheduleForDate } from "./validateServiceScheduleForDate";

type ResolveVoiceScheduleValidationParams = {
  tenantId: string;
  serviceName: string;
  rawDatetime: string;
  channel?: string;
  baseDate?: Date;
};

export type ResolveVoiceScheduleValidationResult =
  | {
      ok: true;
      requestedAt: Date;
    }
  | {
      ok: false;
      reason: "invalid_datetime";
      availableTimes: [];
    }
  | {
      ok: false;
      reason: "schedule_not_available";
      availableTimes: string[];
    };

export async function resolveVoiceScheduleValidation(
  params: ResolveVoiceScheduleValidationParams
): Promise<ResolveVoiceScheduleValidationResult> {
  const parsed = parseVoiceRequestedDate({
    raw: params.rawDatetime,
    baseDate: params.baseDate,
  });

  if (!parsed.ok) {
    return {
      ok: false,
      reason: "invalid_datetime",
      availableTimes: [],
    };
  }

  const scheduleValidation = await validateServiceScheduleForDate({
    tenantId: params.tenantId,
    serviceName: params.serviceName,
    requestedAt: parsed.requestedAt,
    channel: params.channel || "voice",
  });

  if (!scheduleValidation.ok) {
    return {
      ok: false,
      reason: "schedule_not_available",
      availableTimes: scheduleValidation.availableTimes,
    };
  }

  return {
    ok: true,
    requestedAt: parsed.requestedAt,
  };
}