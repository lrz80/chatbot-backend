//src/lib/appointments/getBusinessHoursFallback.ts
import pool from "../db";

type GetBusinessHoursFallbackParams = {
  tenantId: string;
  dayOfWeek: number;
};

type AppointmentSettingsRow = {
  default_duration_min: number | null;
  buffer_min: number | null;
  timezone: string | null;
};

type HorarioDia = {
  open?: boolean;
  start?: string;
  end?: string;
};

type HorarioAtencion = Partial<
  Record<"sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat", HorarioDia>
>;

type GetBusinessHoursFallbackResult = {
  availableTimes: string[];
};

const DAY_KEY_BY_WEEKDAY: Record<number, keyof HorarioAtencion> = {
  0: "sun",
  1: "mon",
  2: "tue",
  3: "wed",
  4: "thu",
  5: "fri",
  6: "sat",
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
  const hh = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
  const mm = String(totalMinutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function buildSlotsByRange(params: {
  start: string;
  end: string;
  durationMin: number;
  bufferMin: number;
}): string[] {
  const startMinutes = hhmmToMinutes(params.start);
  const endMinutes = hhmmToMinutes(params.end);

  if (startMinutes === null || endMinutes === null) {
    return [];
  }

  const durationMin = Number(params.durationMin || 0);
  const bufferMin = Number(params.bufferMin || 0);

  if (durationMin <= 0 || endMinutes <= startMinutes) {
    return [];
  }

  const step = durationMin + Math.max(bufferMin, 0);
  if (step <= 0) {
    return [];
  }

  const slots: string[] = [];

  for (
    let slotStart = startMinutes;
    slotStart + durationMin <= endMinutes;
    slotStart += step
  ) {
    slots.push(minutesToHHMM(slotStart));
  }

  return slots;
}

export async function getBusinessHoursFallback(
  params: GetBusinessHoursFallbackParams
): Promise<GetBusinessHoursFallbackResult> {
  const dayKey = DAY_KEY_BY_WEEKDAY[params.dayOfWeek];

  if (!dayKey) {
    return { availableTimes: [] };
  }

  const tenantResult = await pool.query(
    `
    SELECT horario_atencion
    FROM tenants
    WHERE id = $1
    LIMIT 1
    `,
    [params.tenantId]
  );

  const horarioAtencion = tenantResult.rows[0]?.horario_atencion as HorarioAtencion | null;

  if (!horarioAtencion || typeof horarioAtencion !== "object") {
    return { availableTimes: [] };
  }

  const dayConfig = horarioAtencion[dayKey];

  if (!dayConfig || typeof dayConfig !== "object") {
    return { availableTimes: [] };
  }

  if (dayConfig.open === false) {
    return { availableTimes: [] };
  }

  const start = normalizeHHMM(dayConfig.start || "");
  const end = normalizeHHMM(dayConfig.end || "");

  if (!start || !end) {
    return { availableTimes: [] };
  }

  const settingsResult = await pool.query(
    `
    SELECT default_duration_min, buffer_min, timezone
    FROM appointment_settings
    WHERE tenant_id = $1
    LIMIT 1
    `,
    [params.tenantId]
  );

  const settings = (settingsResult.rows[0] || {}) as AppointmentSettingsRow;

  const durationMin =
    Number(settings.default_duration_min) > 0
      ? Number(settings.default_duration_min)
      : 30;

  const bufferMin =
    Number(settings.buffer_min) >= 0
      ? Number(settings.buffer_min)
      : 0;

  const availableTimes = buildSlotsByRange({
    start,
    end,
    durationMin,
    bufferMin,
  });

  return { availableTimes };
}