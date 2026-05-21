//src/lib/appointments/createAppointmentFromVoice.ts
import pool from "../db";
import { resolveVoiceScheduleValidation } from "./resolveVoiceScheduleValidation";
import { BookingProviderOrchestrator } from "./booking/providers/orchestrator";
import { resolveAppointmentServiceId } from "./resolveAppointmentServiceId";
import { resolveTenantBookingProvider } from "./booking/providers/resolveTenantBookingProvider";
import { resolveSquareServiceMappingFromDbForTenant } from "../integrations/square/resolveSquareServiceMappingFromDbForTenant";
import type { CreateExternalBookingInput } from "./booking/providers/types";

type AppointmentSettings = {
  default_duration_min: number;
  buffer_min: number;
  min_lead_minutes: number;
  timezone: string;
  enabled: boolean;
};

type Args = {
  tenantId: string;
  answersBySlot: Record<string, string | null | undefined>;
  stepKeyToSlot?: Record<string, string>;
  idempotencyKey?: string;
  settings: AppointmentSettings;
};

function humanizeBookingFieldName(key: string): string {
  return String(key || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildExtraBookingDescriptionLines(
  answersBySlot: Record<string, string | null | undefined>,
  stepKeyToSlot: Record<string, string> = {}
): string[] {
  const excludedKeys = new Set([
    "service",
    "datetime",
    "datetime_iso",
    "datetime_display",
    "customer_name",
    "customer_phone",
    "customer_email",
    "confirmation",
    "step_key",
    "value",
    "name",
    "phone",
    "confirm",
    "customer_confirmed",
    "service_display",
    "staff",
    "staff_member",
    "staff_member_id",
    "staff_member_name",
    "staff_member_preference",
    "datetime_reference_suggested_starts",
    "__datetime_reference_suggested_starts",
    "__booking_busy_suggested_starts",
  ]);

  return Object.entries(answersBySlot || {})
    .filter(([key, value]) => {
      const cleanKey = String(key || "").trim();
      const cleanValue = String(value || "").trim();

      if (!cleanKey || !cleanValue) return false;
      if (excludedKeys.has(cleanKey)) return false;

      const canonicalSlot = String(stepKeyToSlot[cleanKey] || "").trim();
      const canonicalValue = canonicalSlot
        ? String(answersBySlot[canonicalSlot] || "").trim()
        : "";

      if (
        canonicalSlot &&
        canonicalSlot !== cleanKey &&
        canonicalValue === cleanValue
      ) {
        return false;
      }

      return true;
    })
    .map(([key, value]) => {
      return `${humanizeBookingFieldName(key)}: ${String(value).trim()}`;
    });
}

function parseIsoDate(value: string | null | undefined): Date | null {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;

  return parsed;
}

function cleanString(value: unknown): string {
  return String(value || "").trim();
}

export async function createAppointmentFromVoice(args: Args) {
  const serviceName = cleanString(args.answersBySlot.service);
  const datetimeText = cleanString(args.answersBySlot.datetime);
  const datetimeIsoText = cleanString(args.answersBySlot.datetime_iso);
  const customerPhone = args.answersBySlot.customer_phone || null;
  const customerName = cleanString(args.answersBySlot.customer_name);
  const customerEmail = args.answersBySlot.customer_email || null;
  const timeZone =
    cleanString(args.settings.timezone) || "America/New_York";

  if (!serviceName) {
    throw new Error("MISSING_SERVICE");
  }

  if (!customerName) {
    throw new Error("MISSING_CUSTOMER_NAME");
  }

  if (!args.settings.enabled) {
    throw new Error("APPOINTMENTS_DISABLED");
  }

  let start: Date | null = parseIsoDate(datetimeIsoText);

  if (!start) {
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

    start = scheduleValidation.requestedAt;
  }

  const activeProvider = await resolveTenantBookingProvider(args.tenantId);

  const resolvedServiceId = await resolveAppointmentServiceId({
    tenantId: args.tenantId,
    serviceName,
  });

  let providerPayload: CreateExternalBookingInput["providerPayload"] | undefined;

  const requestedStaffMemberId = cleanString(args.answersBySlot.staff_member_id);
  const requestedStaffMemberName = cleanString(args.answersBySlot.staff_member_name);

  if (activeProvider === "square") {
    const squareMapping = await resolveSquareServiceMappingFromDbForTenant({
      tenantId: args.tenantId,
      internalServiceKey: serviceName,
    });

    if (!squareMapping.ok) {
      throw new Error(`SQUARE_SERVICE_MAPPING_FAILED:${squareMapping.error}`);
    }

    providerPayload = {
      square: {
        locationId: squareMapping.mapping.externalLocationId,
        serviceVariationId: squareMapping.mapping.externalServiceId,
        serviceVariationVersion:
          squareMapping.mapping.externalServiceVersion ??
          squareMapping.service.variationVersion,
        teamMemberId: requestedStaffMemberId || undefined,
      },
    };
  }

  const duration = args.settings.default_duration_min;
  const end = new Date(start.getTime() + duration * 60 * 1000);

  const idempotencyKey =
    args.idempotencyKey ||
    `voice:${args.tenantId}:${customerPhone || "unknown"}:${start.toISOString()}`;

  const extraDescriptionLines = buildExtraBookingDescriptionLines(
    args.answersBySlot,
    args.stepKeyToSlot || {}
  );

  const orchestrator = new BookingProviderOrchestrator();

  const bookedAt = new Date();

  const bookedAtLabel = new Intl.DateTimeFormat("es-ES", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(bookedAt);

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
      requestedStaffMemberName ? `Staff solicitado: ${requestedStaffMemberName}` : null,
      ...extraDescriptionLines,
      `Booking creado: ${bookedAtLabel}`,
    ]
      .filter(Boolean)
      .join("\n"),
    startISO: start.toISOString(),
    endISO: end.toISOString(),
    timeZone,
    bufferMin: args.settings.buffer_min,
    calendarId: null,
    customer: {
      name: customerName,
      phone: customerPhone,
      email: customerEmail,
    },
    providerPayload,
  });

  if (!externalBooking.ok) {
    if (externalBooking.error === "SLOT_BUSY") {
      const slotBusyError = new Error(
        `SLOT_BUSY:${serviceName}:${start.toISOString()}`
      ) as Error & {
        error?: string;
        suggestedStarts?: string[];
        busy?: Array<{ start: string; end?: string }>;
      };

      slotBusyError.error = "SLOT_BUSY";
      slotBusyError.suggestedStarts = Array.isArray(
        (externalBooking as any).suggestedStarts
      )
        ? (externalBooking as any).suggestedStarts
            .map((item: unknown) => String(item || "").trim())
            .filter(Boolean)
        : [];

      slotBusyError.busy = Array.isArray(externalBooking.busy)
        ? externalBooking.busy
        : [];

      throw slotBusyError;
    }

    if (externalBooking.error === "PROVIDER_NOT_CONFIGURED") {
      throw new Error("BOOKING_PROVIDER_NOT_CONFIGURED");
    }

    if (externalBooking.error === "SQUARE_WRITE_OPERATIONS_NOT_SUPPORTED") {
      throw new Error("SQUARE_WRITE_OPERATIONS_NOT_SUPPORTED");
    }

    throw new Error(
      `EXTERNAL_BOOKING_FAILED:${externalBooking.provider}:${externalBooking.error}`
    );
  }

  const externalCalendarEventId = cleanString(externalBooking.event_id);

  if (!externalCalendarEventId) {
    console.error("🟥 [VOICE][CREATE_APPOINTMENT] Provider returned success without external event id", {
      tenantId: args.tenantId,
      activeProvider,
      serviceName,
      startISO: start.toISOString(),
      provider: externalBooking.provider,
      externalBooking,
    });

    throw new Error(
      `EXTERNAL_BOOKING_NOT_CONFIRMED:${externalBooking.provider}`
    );
  }

  const googleEventId =
    externalBooking.provider === "google_calendar"
      ? externalCalendarEventId
      : null;

  const googleEventLink =
    externalBooking.provider === "google_calendar"
      ? externalBooking.htmlLink
      : null;

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
    ON CONFLICT (tenant_id, channel, customer_phone, start_time)
    DO UPDATE SET
      updated_at = NOW(),
      customer_name = EXCLUDED.customer_name,
      customer_email = EXCLUDED.customer_email,
      end_time = EXCLUDED.end_time,
      status = EXCLUDED.status,
      external_calendar_event_id = EXCLUDED.external_calendar_event_id,
      google_event_id = EXCLUDED.google_event_id,
      google_event_link = EXCLUDED.google_event_link,
      idempotency_key = EXCLUDED.idempotency_key,
      error_reason = NULL
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