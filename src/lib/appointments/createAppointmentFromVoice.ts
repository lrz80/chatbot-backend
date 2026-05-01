//src/lib/appointments/createAppointmentFromVoice.ts
import pool from "../db";
import { resolveVoiceScheduleValidation } from "./resolveVoiceScheduleValidation";
import { BookingProviderOrchestrator } from "./booking/providers/orchestrator";
import { resolveAppointmentServiceId } from "./resolveAppointmentServiceId";

type AppointmentSettings = {
  default_duration_min: number;
  buffer_min: number;
  min_lead_minutes: number;
  timezone: string;
  enabled: boolean;
};

type BookingSlot =
  | "service"
  | "datetime"
  | "customer_name"
  | "customer_phone"
  | "customer_email"
  | "confirmation";

type Args = {
  tenantId: string;
  answersBySlot: Partial<Record<BookingSlot, string>>;
  idempotencyKey?: string;
  settings: AppointmentSettings;
};

export async function createAppointmentFromVoice(args: Args) {
  const serviceName = String(args.answersBySlot.service || "").trim();
  const datetimeText = args.answersBySlot.datetime || "";
  const customerPhone = args.answersBySlot.customer_phone || null;
  const customerName = args.answersBySlot.customer_name || "Cliente Voz";
  const customerEmail = args.answersBySlot.customer_email || null;
  const timeZone =
    String(args.settings.timezone || "").trim() || "America/New_York";

  if (!serviceName) {
    throw new Error("MISSING_SERVICE");
  }

  if (!args.settings.enabled) {
    throw new Error("APPOINTMENTS_DISABLED");
  }

  const scheduleValidation = await resolveVoiceScheduleValidation({
    tenantId: args.tenantId,
    serviceName,
    rawDatetime: datetimeText,
    channel: "voice",
  });

  if (!scheduleValidation.ok) {
    if (scheduleValidation.reason === "invalid_datetime") {
      throw new Error(`INVALID_VOICE_DATETIME: ${datetimeText}`);
    }

    throw new Error(
      `VOICE_SCHEDULE_NOT_AVAILABLE:${serviceName}:${scheduleValidation.availableTimes.join(",")}`
    );
  }

  const start = scheduleValidation.requestedAt;

  const duration = args.settings.default_duration_min;
  const end = new Date(start.getTime() + duration * 60 * 1000);

  const idempotencyKey =
    args.idempotencyKey ||
    `voice:${args.tenantId}:${customerPhone || "unknown"}:${start.toISOString()}`;

  const orchestrator = new BookingProviderOrchestrator();

  const externalBooking = await orchestrator.createExternalBooking({
    tenantId: args.tenantId,
    summary: serviceName,
    description: [
      `Agendado por: Aamy`,
      `Servicio: ${serviceName}`,
      `Canal: voice`,
      `Cliente: ${customerName}`,
      customerPhone ? `Teléfono: ${customerPhone}` : null,
      customerEmail ? `Email: ${customerEmail}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    startISO: start.toISOString(),
    endISO: end.toISOString(),
    timeZone,
    bufferMin: args.settings.buffer_min,
    calendarId: null,
  });

  if (!externalBooking.ok) {
    if (externalBooking.error === "SLOT_BUSY") {
       throw new Error(
        `VOICE_SCHEDULE_NOT_AVAILABLE:${serviceName}:${externalBooking.busy
          .map((item) => item.start)
          .join(",")}`
        );
    }

    if (externalBooking.error === "PROVIDER_NOT_CONFIGURED") {
      throw new Error("BOOKING_PROVIDER_NOT_CONFIGURED");
    }

    throw new Error(
      `EXTERNAL_BOOKING_FAILED:${externalBooking.provider}:${externalBooking.error}`
    );
    }

  const externalCalendarEventId = externalBooking.event_id;
  const googleEventId =
    externalBooking.provider === "google_calendar"
      ? externalBooking.event_id
      : null;
  const googleEventLink =
    externalBooking.provider === "google_calendar"
      ? externalBooking.htmlLink
      : null;

  const resolvedServiceId = await resolveAppointmentServiceId({
    tenantId: args.tenantId,
    serviceName,
  });

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
      $2,
      'voice',
      $3,
      $4,
      $5,
      $6,
      $7,
      'confirmed',
      $8,
      $9,
      $10,
      $11,
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
      resolvedServiceId,
      customerName,
      customerPhone,
      customerEmail,
      start.toISOString(),
      end.toISOString(),
      externalCalendarEventId,
      googleEventId,
      googleEventLink,
      idempotencyKey,
    ]
  );

  return rows[0];
}