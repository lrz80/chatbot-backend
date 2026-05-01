//src/lib/appointments/validateServiceScheduleForDate.ts
import { validateServiceSchedule } from "./validateServiceSchedule";

type ValidateServiceScheduleForDateParams = {
  tenantId: string;
  serviceName: string;
  requestedAt: Date;
  channel?: string;
  timeZone?: string;
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

export async function validateServiceScheduleForDate(
  params: ValidateServiceScheduleForDateParams
) {
  const timeZone = params.timeZone || "America/New_York";

  const dayOfWeek = getWeekdayInTimeZone(params.requestedAt, timeZone);
  const timeHHMM = getHHMMInTimeZone(params.requestedAt, timeZone);

  return validateServiceSchedule({
    tenantId: params.tenantId,
    serviceName: params.serviceName,
    dayOfWeek,
    timeHHMM,
    channel: params.channel || "voice",
  });
}