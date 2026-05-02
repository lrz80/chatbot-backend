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

export async function validateServiceSchedule(
  params: ValidateServiceScheduleParams
): Promise<ValidateServiceScheduleResult> {
  const requestedTime = normalizeHHMM(params.timeHHMM);

  console.log("[VOICE][VALIDATE_SERVICE_SCHEDULE][INPUT]", {
    tenantId: params.tenantId,
    serviceName: params.serviceName,
    dayOfWeek: params.dayOfWeek,
    timeHHMM: params.timeHHMM,
    requestedTime,
    channel: params.channel || "voice",
  });

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

  console.log("[VOICE][VALIDATE_SERVICE_SCHEDULE][SERVICE_SCHEDULES]", {
    enabledSchedulesCount: enabledSchedules.length,
    sameDaySchedulesCount: sameDaySchedules.length,
    availableTimesSameDay,
    requestedTime,
  });

  if (availableTimesSameDay.includes(requestedTime)) {
    return { ok: true };
  }

  // Si el tenant sí configuró horarios por servicio, se respetan.
  if (tenantHasAnyVoiceServiceSchedules) {
    return {
      ok: false,
      availableTimes: availableTimesSameDay,
    };
  }

  console.log("[VOICE][VALIDATE_SERVICE_SCHEDULE][FALLBACK_TRIGGER]", {
    tenantHasAnyVoiceServiceSchedules,
    requestedTime,
    tenantId: params.tenantId,
    dayOfWeek: params.dayOfWeek,
  });

  // Si NO hay horarios por servicio, caer al horario general del negocio.
  const businessFallback = await getBusinessHoursFallback({
    tenantId: params.tenantId,
    dayOfWeek: params.dayOfWeek,
  });

  console.log("[VOICE][VALIDATE_SERVICE_SCHEDULE][BUSINESS_FALLBACK]", {
    tenantId: params.tenantId,
    dayOfWeek: params.dayOfWeek,
    requestedTime,
    availableBusinessTimes: businessFallback.availableTimes,
  });

  if (businessFallback.availableTimes.includes(requestedTime)) {
    return { ok: true };
  }

  return {
    ok: false,
    availableTimes: businessFallback.availableTimes,
  };
}