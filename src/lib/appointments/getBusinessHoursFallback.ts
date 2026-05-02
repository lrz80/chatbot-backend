//src/lib/appointments/getBusinessHoursFallback.ts
import pool from "../db";

type GetBusinessHoursFallbackParams = {
  tenantId: string;
  dayOfWeek: number;
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
  start: string | null;
  end: string | null;
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

export async function getBusinessHoursFallback(
  params: GetBusinessHoursFallbackParams
): Promise<GetBusinessHoursFallbackResult> {
  const dayKey = DAY_KEY_BY_WEEKDAY[params.dayOfWeek];

  if (!dayKey) {
    return { start: null, end: null };
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
    return { start: null, end: null };
  }

  const dayConfig = horarioAtencion[dayKey];

  if (!dayConfig || typeof dayConfig !== "object") {
    return { start: null, end: null };
  }

  if (dayConfig.open === false) {
    return { start: null, end: null };
  }

  const start = normalizeHHMM(dayConfig.start || "");
  const end = normalizeHHMM(dayConfig.end || "");

  if (!start || !end) {
    return { start: null, end: null };
  }

  return { start, end };
}