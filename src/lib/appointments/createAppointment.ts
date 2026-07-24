// src/lib/appointments/createAppointment.ts
import pool from "../db";
import { resolveVoiceScheduleValidation } from "./resolveVoiceScheduleValidation";
import { BookingProviderOrchestrator } from "./booking/providers/orchestrator";
import { resolveAppointmentServiceId } from "./resolveAppointmentServiceId";
import { resolveTenantBookingProvider } from "./booking/providers/resolveTenantBookingProvider";
import { resolveSquareServiceMappingFromDbForTenant } from "../integrations/square/resolveSquareServiceMappingFromDbForTenant";
import type { CreateExternalBookingInput } from "./booking/providers/types";
import { resolveBookingDepositPolicyFromExternalMetadata } from "./resolveBookingDepositPolicy";
import { createPendingDepositPaymentRequest } from "./deposits/createPendingDepositPaymentRequest";
import {
  syncAppointmentToFieldOperations,
} from "../../modules/field-operations/services/fieldOperationsSync.service";

import {
  geocodeFieldServiceBaseAddress,
  validateFieldServiceArea,
} from "../../modules/field-operations/services/fieldServiceArea.service";

import {
  planFieldServiceBooking,
} from "../../modules/field-operations/services/bookingPlanning.service";

import {
  checkRouteFeasibility,
} from "../../modules/field-operations/services/routeFeasibility.service";

type AppointmentSettings = {
  default_duration_min: number;
  buffer_min: number;
  min_lead_minutes: number;
  timezone: string;
  enabled: boolean;

  field_service_area_enabled: boolean;
};

export type AppointmentBookingChannel =
  | "voice"
  | "whatsapp"
  | "facebook"
  | "instagram";

export type CreateAppointmentArgs = {
  tenantId: string;
  channel: AppointmentBookingChannel;
  sessionId?: string | null;

  answersBySlot: Record<
    string,
    string | null | undefined
  >;

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
    "field_operation_resource_id",
    "field_operation_resource_name",
    "resource_id",
    "__datetime_planned_slots",
    "__datetime_reference_window_key",
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

export async function createAppointment(
  args: CreateAppointmentArgs
) {
  const serviceName = cleanString(args.answersBySlot.service);
  const datetimeText = cleanString(args.answersBySlot.datetime);

  const serviceAddress =
    cleanString(args.answersBySlot.address) ||
    cleanString(args.answersBySlot.service_address) ||
    cleanString(args.answersBySlot.location) ||
    cleanString(args.answersBySlot.property_address);

  const isFieldServiceBooking =
    args.settings.field_service_area_enabled === true;

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
      channel: args.channel,
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

  let normalizedFieldServiceAddress:
    string | null = null;

  let fieldServiceLatitude:
    number | null = null;

  let fieldServiceLongitude:
    number | null = null;

  if (isFieldServiceBooking) {
    if (!serviceAddress) {
      throw new Error(
        "FIELD_SERVICE_ADDRESS_REQUIRED"
      );
    }

    const geocodedAddress =
      await geocodeFieldServiceBaseAddress({
        address: serviceAddress,
      });

    normalizedFieldServiceAddress =
      geocodedAddress.formattedAddress;

    fieldServiceLatitude =
      geocodedAddress.latitude;

    fieldServiceLongitude =
      geocodedAddress.longitude;

    const areaValidation =
      await validateFieldServiceArea({
        tenantId: args.tenantId,
        latitude: fieldServiceLatitude,
        longitude: fieldServiceLongitude,
      });

    if (!areaValidation.allowed) {
      const areaError = new Error(
        areaValidation.reason ||
          "FIELD_SERVICE_LOCATION_NOT_ALLOWED"
      ) as Error & {
        code?: string;
        distanceMiles?: number | null;
        radiusMiles?: number | null;
        formattedAddress?: string | null;
      };

      areaError.code =
        areaValidation.reason ||
        "FIELD_SERVICE_LOCATION_NOT_ALLOWED";

      areaError.distanceMiles =
        areaValidation.distanceMiles;

      areaError.radiusMiles =
        areaValidation.radiusMiles;

      areaError.formattedAddress =
        normalizedFieldServiceAddress;

      throw areaError;
    }
  }

  const activeProvider = await resolveTenantBookingProvider(args.tenantId);

  const resolvedServiceId = await resolveAppointmentServiceId({
    tenantId: args.tenantId,
    serviceName,
  });

  let providerPayload: CreateExternalBookingInput["providerPayload"] | undefined;

  let plannedResourceId:
    string | null = null;

  let plannedResourceName:
    string | null = null;

  let plannedResourceMetadata:
    Record<string, unknown> | null = null;

  const requestedStaffMemberId = cleanString(args.answersBySlot.staff_member_id);
  const requestedStaffMemberName = cleanString(args.answersBySlot.staff_member_name);

  const duration = args.settings.default_duration_min;
  const end = new Date(start.getTime() + duration * 60 * 1000);

    if (isFieldServiceBooking) {
    if (
      fieldServiceLatitude === null ||
      fieldServiceLongitude === null
    ) {
      throw new Error(
        "FIELD_SERVICE_COORDINATES_REQUIRED_FOR_PLANNING"
      );
    }

    const requestedInternalResourceId =
      cleanString(
        args.answersBySlot
          .field_operation_resource_id
      ) ||
      cleanString(
        args.answersBySlot.resource_id
      ) ||
      null;

    const fieldPlanning =
      await planFieldServiceBooking({
        tenantId:
          args.tenantId,

        startAt:
          start,

        endAt:
          end,

        latitude:
          fieldServiceLatitude,

        longitude:
          fieldServiceLongitude,

        customerPhone:
          customerPhone
            ? String(customerPhone)
            : null,

        requestedResourceId:
          requestedInternalResourceId,
      });

    if (!fieldPlanning.ok) {
      const planningError =
        new Error(
          `FIELD_SERVICE_ROUTE_UNAVAILABLE:${fieldPlanning.error}`
        ) as Error & {
          code?: string;
          suggestedStarts?: string[];
          candidatesEvaluated?: number;
          candidatesRejected?: number;
          rejectedCandidates?: unknown[];
        };

      planningError.code =
        "FIELD_SERVICE_ROUTE_UNAVAILABLE";

      planningError.suggestedStarts = [];

      planningError.candidatesEvaluated =
        fieldPlanning.candidatesEvaluated;

      planningError.candidatesRejected =
        fieldPlanning.candidatesRejected;

      planningError.rejectedCandidates =
        fieldPlanning.rejectedCandidates;

      throw planningError;
    }

    plannedResourceId =
      fieldPlanning.resourceId;

    plannedResourceName =
      fieldPlanning.resourceName;

    plannedResourceMetadata = {
      planningVersion:
        "route_feasibility_v1",

      plannedAt:
        new Date().toISOString(),

      resourceName:
        fieldPlanning.resourceName,

      candidatesEvaluated:
        fieldPlanning.candidatesEvaluated,

      candidatesRejected:
        fieldPlanning.candidatesRejected,

      score:
        Number.isFinite(
          fieldPlanning.candidate
            .score.totalScore
        )
          ? Number(
              fieldPlanning.candidate
                .score.totalScore
                .toFixed(4)
            )
          : null,

      routeFeasible:
        fieldPlanning.candidate
          .routeFeasible,

      routeViolations:
        fieldPlanning.candidate
          .routeViolations,
    };

    console.log(
      "[FIELD_OPERATIONS][BOOKING_RESOURCE_PLANNED]",
      {
        tenantId:
          args.tenantId,

        resourceId:
          plannedResourceId,

        resourceName:
          plannedResourceName,

        startISO:
          start.toISOString(),

        endISO:
          end.toISOString(),

        candidatesEvaluated:
          fieldPlanning.candidatesEvaluated,

        candidatesRejected:
          fieldPlanning.candidatesRejected,
      }
    );
  }

  const idempotencyKey =
    args.idempotencyKey ||
    [
      args.channel,
      args.tenantId,
      args.sessionId || customerPhone || "unknown",
      start.toISOString(),
    ].join(":");

  if (activeProvider === "square") {
    const squareMapping = await resolveSquareServiceMappingFromDbForTenant({
      tenantId: args.tenantId,
      internalServiceKey: serviceName,
    });

    if (!squareMapping.ok) {
      throw new Error(`SQUARE_SERVICE_MAPPING_FAILED:${squareMapping.error}`);
    }

    const depositPolicy = resolveBookingDepositPolicyFromExternalMetadata(
      squareMapping.mapping.externalMetadata
    );

    console.log("[VOICE][DEPOSIT_POLICY_RESOLVED]", {
      tenantId: args.tenantId,
      serviceName,
      externalServiceId: squareMapping.mapping.externalServiceId,
      externalLocationId: squareMapping.mapping.externalLocationId,
      externalMetadata: squareMapping.mapping.externalMetadata,
      depositPolicy,
    });

    if (depositPolicy.required) {
      if (!depositPolicy.amountCents || depositPolicy.amountCents <= 0) {
        throw new Error("DEPOSIT_AMOUNT_NOT_CONFIGURED");
      }

      if (!squareMapping.mapping.externalLocationId) {
        throw new Error("DEPOSIT_SQUARE_LOCATION_NOT_CONFIGURED");
      }

      const pendingPayment = await createPendingDepositPaymentRequest({
        tenantId: args.tenantId,
        channel: args.channel,

        customerName,
        customerPhone: customerPhone ? String(customerPhone) : null,
        customerEmail: customerEmail ? String(customerEmail) : null,

        serviceName,
        startISO: start.toISOString(),
        endISO: end.toISOString(),
        timeZone,

        staffMemberId: requestedStaffMemberId || null,
        staffMemberName: requestedStaffMemberName || null,

        depositAmountCents: depositPolicy.amountCents,
        depositCurrency: depositPolicy.currency,
        depositPolicyText: depositPolicy.policyText,

        squareLocationId: squareMapping.mapping.externalLocationId,
        providerPayload: {
          square: {
            locationId: squareMapping.mapping.externalLocationId,
            serviceVariationId: squareMapping.mapping.externalServiceId,
            serviceVariationVersion:
              squareMapping.mapping.externalServiceVersion ??
              squareMapping.service.variationVersion,
            teamMemberId: requestedStaffMemberId || undefined,
          },
        },
        answersBySlot: args.answersBySlot,
        idempotencyKey,
      });

      if (!pendingPayment.ok) {
        throw new Error(`DEPOSIT_PAYMENT_LINK_FAILED:${pendingPayment.error}`);
      }

      const depositError = new Error("BOOKING_REQUIRES_DEPOSIT") as Error & {
        code?: string;
        serviceName?: string;
        amountCents?: number | null;
        currency?: string;
        paymentUrl?: string | null;
        policyText?: string | null;
        paymentRequestId?: string;
        squarePaymentLinkId?: string;
        squareOrderId?: string | null;
      };

      depositError.code = "BOOKING_REQUIRES_DEPOSIT";
      depositError.serviceName = serviceName;
      depositError.amountCents = depositPolicy.amountCents;
      depositError.currency = depositPolicy.currency;
      depositError.paymentUrl = pendingPayment.paymentLinkUrl;
      depositError.policyText = depositPolicy.policyText;
      depositError.paymentRequestId = pendingPayment.paymentRequestId;
      depositError.squarePaymentLinkId = pendingPayment.squarePaymentLinkId;
      depositError.squareOrderId = pendingPayment.squareOrderId;

      throw depositError;
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

    if (
    isFieldServiceBooking &&
    plannedResourceId &&
    fieldServiceLatitude !== null &&
    fieldServiceLongitude !== null
  ) {
    const finalRouteValidation =
      await checkRouteFeasibility({
        tenantId:
          args.tenantId,

        resourceId:
          plannedResourceId,

        startAt:
          start,

        endAt:
          end,

        latitude:
          fieldServiceLatitude,

        longitude:
          fieldServiceLongitude,

        formattedAddress:
          normalizedFieldServiceAddress ||
          serviceAddress,
      });

    if (!finalRouteValidation.feasible) {
      const stalePlanningError =
        new Error(
          "FIELD_SERVICE_ROUTE_CHANGED_BEFORE_BOOKING"
        ) as Error & {
          code?: string;
          resourceId?: string;
          violations?: unknown[];
          suggestedStarts?: string[];
        };

      stalePlanningError.code =
        "FIELD_SERVICE_ROUTE_CHANGED_BEFORE_BOOKING";

      stalePlanningError.resourceId =
        plannedResourceId;

      stalePlanningError.violations =
        finalRouteValidation.violations;

      stalePlanningError.suggestedStarts = [];

      throw stalePlanningError;
    }
  }

  const externalBooking = await orchestrator.createExternalBooking({
    tenantId: args.tenantId,
    summary: serviceName,
    description: [
      `Agendado por: Aamy`,
      `Servicio: ${serviceName}`,
      `Canal: ${args.channel}`,
      `Cliente: ${customerName}`,
      customerPhone ? `Teléfono: ${customerPhone}` : null,
      customerEmail ? `Email: ${customerEmail}` : null,
      requestedStaffMemberName ? `Staff solicitado: ${requestedStaffMemberName}` : null,
      plannedResourceName
        ? `Recurso operativo: ${plannedResourceName}`
        : null,
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
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      'confirmed',
      $9,
      $10,
      $11,
      $12,
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
      args.channel,
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

    const appointment = rows[0];

    if (isFieldServiceBooking) {
      await syncAppointmentToFieldOperations({
        tenantId:
          args.tenantId,

        appointmentId:
          appointment.id,

        address:
          normalizedFieldServiceAddress ||
          serviceAddress,

        latitude:
          fieldServiceLatitude,

        longitude:
          fieldServiceLongitude,

        plannedResourceId,

        plannedResourceMetadata,

        answersBySlot:
          args.answersBySlot,
      });
    }

    return appointment;
  }