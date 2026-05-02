//src/lib/appointments/validateServiceSchedule.ts
import { getServiceSchedules } from "./getServiceSchedules";
import { getBusinessHoursFallback } from "./getBusinessHoursFallback";

type ValidateServiceScheduleParams = {
  tenantId: string;
  serviceName: string;
  dayOfWeek: number;
  timeHHMM: string;
  channel?: string;
};

export type ValidateServiceScheduleResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      availableTimes: string[];
    };

function normalizeHHMM(value: string): string {
  const raw = (value || "").trim();

  if (!raw) return "";

  const parts = raw.split(":");
  const hh = (parts[0] || "").padStart(2, "0");
  const mm = (parts[1] || "00").padStart(2, "0");

  return `${hh}:${mm}`;
}

function hhmmToMinutes(value: string): number | null {
  const normalized = normalizeHHMM(value);
  if (!normalized) return null;

  const [hh, mm] = normalized.split(":").map(Number);

  if (
    Number.isNaN(hh) ||
    Number.isNaN(mm) ||
    hh < 0 ||
    hh > 23 ||
    mm < 0 ||
    mm > 59
  ) {
    return null;
  }

  return hh * 60 + mm;
}

export async function validateServiceSchedule(
  params: ValidateServiceScheduleParams
): Promise<ValidateServiceScheduleResult> {
  const requestedTime = normalizeHHMM(params.timeHHMM);

  const schedules = await getServiceSchedules({
    tenantId: params.tenantId,
    channel: params.channel || "voice",
  });

  const enabledSchedules = schedules.filter((row) => row.enabled === true);

  const tenantHasAnyVoiceServiceSchedules = enabledSchedules.length > 0;

  const sameDaySchedules = enabledSchedules.filter(
    (row) =>
      row.service_name === params.serviceName &&
      row.day_of_week === params.dayOfWeek
  );

  const availableTimesSameDay = sameDaySchedules.map((row) =>
    String(row.start_time).slice(0, 5)
  );

  if (availableTimesSameDay.includes(requestedTime)) {
    return { ok: true };
  }

  if (tenantHasAnyVoiceServiceSchedules) {
    return {
      ok: false,
      availableTimes: availableTimesSameDay,
    };
  }

  const businessFallback = await getBusinessHoursFallback({
    tenantId: params.tenantId,
    dayOfWeek: params.dayOfWeek,
  });

  if (!businessFallback.start || !businessFallback.end) {
    return {
      ok: false,
      availableTimes: [],
    };
  }

  const requestedMinutes = hhmmToMinutes(requestedTime);
  const startMinutes = hhmmToMinutes(businessFallback.start);
  const endMinutes = hhmmToMinutes(businessFallback.end);

  if (
    requestedMinutes === null ||
    startMinutes === null ||
    endMinutes === null
  ) {
    return {
      ok: false,
      availableTimes: [],
    };
  }

  const isWithinBusinessRange =
    requestedMinutes >= startMinutes && requestedMinutes < endMinutes;

  if (isWithinBusinessRange) {
    return { ok: true };
  }

  return {
    ok: false,
    availableTimes: [businessFallback.start, businessFallback.end],
  };
}