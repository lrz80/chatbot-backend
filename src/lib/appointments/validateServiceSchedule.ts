//src/lib/appointments/validateServiceSchedule.ts
import { getServiceSchedules } from "./getServiceSchedules";

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

export async function validateServiceSchedule(
  params: ValidateServiceScheduleParams
): Promise<ValidateServiceScheduleResult> {
  const schedules = await getServiceSchedules({
    tenantId: params.tenantId,
    channel: params.channel || "voice",
  });

  const requestedTime = normalizeHHMM(params.timeHHMM);

  const sameDaySchedules = schedules.filter(
    (row) =>
      row.enabled === true &&
      row.service_name === params.serviceName &&
      row.day_of_week === params.dayOfWeek
    );

    const availableTimesSameDay = sameDaySchedules.map((row) =>
      String(row.start_time).slice(0, 5)
    );

    const exists = availableTimesSameDay.includes(requestedTime);

    if (!exists) {
      return {
        ok: false,
        availableTimes: availableTimesSameDay,
    };
  }

  return { ok: true };
}