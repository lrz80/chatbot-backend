//src/lib/appointments/validateServiceScheduleForDate.ts
import { validateServiceSchedule } from "./validateServiceSchedule";

type ValidateServiceScheduleForDateParams = {
  tenantId: string;
  serviceName: string;
  requestedAt: Date;
  channel?: string;
};

export async function validateServiceScheduleForDate(
  params: ValidateServiceScheduleForDateParams
) {
  const requestedAt = params.requestedAt;

  const dayOfWeek = requestedAt.getDay();

  const hh = String(requestedAt.getHours()).padStart(2, "0");
  const mm = String(requestedAt.getMinutes()).padStart(2, "0");
  const timeHHMM = `${hh}:${mm}`;

  return validateServiceSchedule({
    tenantId: params.tenantId,
    serviceName: params.serviceName,
    dayOfWeek,
    timeHHMM,
    channel: params.channel || "voice",
  });
}