//src/lib/appointments/createAppointmentFromVoice.ts
import pool from "../db";

type AppointmentSettings = {
  default_duration_min: number;
  buffer_min: number;
  min_lead_minutes: number;
  timezone: string;
  enabled: boolean;
};

type Args = {
  tenantId: string;
  serviceName: string;
  customerPhone: string | null;
  customerName?: string | null;
  datetimeText: string;
  idempotencyKey?: string;
  settings: AppointmentSettings;
};

function parseVoiceDatetime(input: string): Date | null {
  const raw = (input || "").trim().toLowerCase();
  const now = new Date();
  const target = new Date(now);

  if (raw.includes("mañana")) target.setDate(target.getDate() + 1);

  const hourMatch = raw.match(/\b(\d{1,2})(?::(\d{2}))?\b/);
  if (!hourMatch) return null;

  let hour = Number(hourMatch[1]);
  const minute = hourMatch[2] ? Number(hourMatch[2]) : 0;

  const isMorning = raw.includes("mañana") || raw.includes("am") || raw.includes("a.m");
  const isAfternoon = raw.includes("tarde") || raw.includes("noche") || raw.includes("pm") || raw.includes("p.m");

  if (isAfternoon && hour < 12) hour += 12;
  if (isMorning && hour === 12) hour = 0;

  target.setHours(hour, minute, 0, 0);
  return Number.isNaN(target.getTime()) ? null : target;
}

export async function createAppointmentFromVoice(args: Args) {
  const start = parseVoiceDatetime(args.datetimeText);

  if (!start) {
    throw new Error(`INVALID_VOICE_DATETIME: ${args.datetimeText}`);
  }

  if (!args.settings.enabled) {
    throw new Error("APPOINTMENTS_DISABLED");
  }

  const duration = args.settings.default_duration_min;
  const end = new Date(start.getTime() + duration * 60 * 1000);

  const idempotencyKey =
    args.idempotencyKey ||
    `voice:${args.tenantId}:${args.customerPhone || "unknown"}:${start.toISOString()}`;

  const { rows } = await pool.query(
    `
    INSERT INTO appointments (
      tenant_id,
      service_id,
      channel,
      customer_name,
      customer_phone,
      customer_email,
      start_time,
      end_time,
      status,
      external_calendar_event_id,
      google_event_id,
      google_event_link,
      idempotency_key,
      error_reason,
      created_at,
      updated_at
    )
    VALUES (
      $1,
      NULL,
      'voice',
      $2,
      $3,
      NULL,
      $4,
      $5,
      'confirmed',
      NULL,
      NULL,
      NULL,
      $6,
      NULL,
      NOW(),
      NOW()
    )
    ON CONFLICT (idempotency_key)
    DO UPDATE SET
      updated_at = NOW()
    RETURNING *
    `,
    [
      args.tenantId,
      args.customerName || "Cliente Voz",
      args.customerPhone,
      start.toISOString(),
      end.toISOString(),
      idempotencyKey,
    ]
  );

  return rows[0];
}