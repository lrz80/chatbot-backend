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
  const raw = String(value || "").trim();

  if (!raw) return "";

  const parts = raw.split(":");
  const hh = String(parts[0] || "").padStart(2, "0");
  const mm = String(parts[1] || "00").padStart(2, "0");

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

function dedupeAndSortTimes(values: string[]): string[] {
  const unique = Array.from(
    new Set(
      values
        .map((value) => normalizeHHMM(value))
        .filter(Boolean)
    )
  );

  return unique.sort((a, b) => {
    const aMinutes = hhmmToMinutes(a);
    const bMinutes = hhmmToMinutes(b);

    if (aMinutes === null && bMinutes === null) return 0;
    if (aMinutes === null) return 1;
    if (bMinutes === null) return -1;

    return aMinutes - bMinutes;
  });
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

  const sameServiceSameDaySchedules = enabledSchedules.filter(
    (row) =>
      row.service_name === params.serviceName &&
      row.day_of_week === params.dayOfWeek
  );

  const availableTimesSameServiceSameDay = dedupeAndSortTimes(
    sameServiceSameDaySchedules.map((row) => String(row.start_time).slice(0, 5))
  );

  if (availableTimesSameServiceSameDay.includes(requestedTime)) {
    return { ok: true };
  }

  if (availableTimesSameServiceSameDay.length > 0) {
    return {
      ok: false,
      availableTimes: availableTimesSameServiceSameDay,
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
    availableTimes: dedupeAndSortTimes([
      businessFallback.start,
      businessFallback.end,
    ]),
  };
}