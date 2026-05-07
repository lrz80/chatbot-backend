//src/lib/appointments/validateServiceSchedule.ts
import { getServiceSchedules } from "./getServiceSchedules";
import { getBusinessHoursFallback } from "./getBusinessHoursFallback";

type ValidateServiceScheduleParams = {
  tenantId: string;
  serviceName: string;
  dayOfWeek: number;
  timeHHMM: string;
  channel?: string;
  durationMin?: number;
  bufferMin?: number;
  includeBufferInClosingBoundary?: boolean;
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

function minutesToHHMM(totalMinutes: number): string {
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;

  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
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

function buildFallbackAvailableTimes(params: {
  start: string;
  end: string;
  durationMin: number;
  bufferMin: number;
  includeBufferInClosingBoundary: boolean;
}): string[] {
  const startMinutes = hhmmToMinutes(params.start);
  const endMinutes = hhmmToMinutes(params.end);

  if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
    return [];
  }

  const occupiedMinutes = params.includeBufferInClosingBoundary
    ? params.durationMin + params.bufferMin
    : params.durationMin;

  if (occupiedMinutes <= 0) {
    return [];
  }

  const latestValidStart = endMinutes - occupiedMinutes;

  if (latestValidStart < startMinutes) {
    return [];
  }

  if (latestValidStart === startMinutes) {
    return [minutesToHHMM(startMinutes)];
  }

  return dedupeAndSortTimes([
    minutesToHHMM(startMinutes),
    minutesToHHMM(latestValidStart),
  ]);
}

function isStartValidInsideBusinessWindow(params: {
  requestedTime: string;
  start: string;
  end: string;
  durationMin: number;
  bufferMin: number;
  includeBufferInClosingBoundary: boolean;
}): boolean {
  const requestedMinutes = hhmmToMinutes(params.requestedTime);
  const startMinutes = hhmmToMinutes(params.start);
  const endMinutes = hhmmToMinutes(params.end);

  if (
    requestedMinutes === null ||
    startMinutes === null ||
    endMinutes === null ||
    endMinutes <= startMinutes
  ) {
    return false;
  }

  const occupiedMinutes = params.includeBufferInClosingBoundary
    ? params.durationMin + params.bufferMin
    : params.durationMin;

  if (occupiedMinutes <= 0) {
    return false;
  }

  const requestedEndBoundary = requestedMinutes + occupiedMinutes;

  return (
    requestedMinutes >= startMinutes &&
    requestedEndBoundary <= endMinutes
  );
}

export async function validateServiceSchedule(
  params: ValidateServiceScheduleParams
): Promise<ValidateServiceScheduleResult> {
  const requestedTime = normalizeHHMM(params.timeHHMM);

  const durationMin =
    typeof params.durationMin === "number" && params.durationMin > 0
      ? params.durationMin
      : 30;

  const bufferMin =
    typeof params.bufferMin === "number" && params.bufferMin >= 0
      ? params.bufferMin
      : 0;

  const includeBufferInClosingBoundary =
    params.includeBufferInClosingBoundary !== false;

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

  const isWithinBusinessRange = isStartValidInsideBusinessWindow({
    requestedTime,
    start: businessFallback.start,
    end: businessFallback.end,
    durationMin,
    bufferMin,
    includeBufferInClosingBoundary,
  });

  if (isWithinBusinessRange) {
    return { ok: true };
  }

  return {
    ok: false,
    availableTimes: buildFallbackAvailableTimes({
      start: businessFallback.start,
      end: businessFallback.end,
      durationMin,
      bufferMin,
      includeBufferInClosingBoundary,
    }),
  };
}