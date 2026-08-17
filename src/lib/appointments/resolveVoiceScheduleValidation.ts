//src/lib/appointments/resolveVoiceScheduleValidation.ts
import pool from "../db";
import { parseVoiceRequestedDate } from "./parseVoiceRequestedDate";
import { validateServiceScheduleForDate } from "./validateServiceScheduleForDate";
import { BookingProviderOrchestrator } from "./booking/providers/orchestrator";
import {
  filterRouteAwareAvailability,
} from "../../modules/field-operations/services/routeAwareAvailability.service";
import {
  resolveVoiceBookableStartsForDate,
} from "./resolveVoiceAvailabilityWindow";

type ResolveVoiceScheduleValidationParams = {
  tenantId: string;
  serviceName: string;
  rawDatetime: string;
  channel?: string;
  baseDate?: Date;
  timeZone?: string;
  durationMin?: number;
  bufferMin?: number;
  referenceSuggestedStarts?: string[];

  fieldServiceAreaEnabled?: boolean;

  serviceAddress?: string | null;
  serviceLatitude?: number | null;
  serviceLongitude?: number | null;
  serviceFormattedAddress?: string | null;

  customerPhone?: string | null;

  requestedResourceId?: string | null;
};

export type ResolveVoiceScheduleValidationResult =
  | {
      ok: true;
      requestedAt: Date;
      timeZone: string;
    }
  | {
      ok: false;
      reason: "invalid_datetime";
      availableTimes: [];
      suggestedStarts: [];
      timeZone: string;
    }
  | {
      ok: false;
      reason: "lead_time_not_met";
      requestedAt: Date;
      availableTimes: [];
      suggestedStarts: string[];
      timeZone: string;
    }
  | {
      ok: false;
      reason: "schedule_not_available";
      requestedAt: Date;
      availableTimes: string[];
      suggestedStarts: string[];
      timeZone: string;
    }
  | {
      ok: false;
      reason:
        | "provider_not_configured"
        | "provider_auth_required"
        | "provider_unavailable"
        | "provider_check_failed";
      providerError: string;
      requestedAt: Date;
      availableTimes: [];
      suggestedStarts: string[];
      timeZone: string;
    };

function dedupeStringArray(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

export async function resolveVoiceScheduleValidation(
  params: ResolveVoiceScheduleValidationParams
): Promise<ResolveVoiceScheduleValidationResult> {
  const timeZone =
    String(params.timeZone || "America/New_York").trim() || "America/New_York";

  const parsed = parseVoiceRequestedDate({
    raw: params.rawDatetime,
    baseDate: params.baseDate,
    timeZone,
    referenceSuggestedStarts: params.referenceSuggestedStarts,
  });

  console.log("[VOICE][DATETIME_PARSE]", {
    tenantId: params.tenantId,
    serviceName: params.serviceName,
    rawDatetime: params.rawDatetime,
    timeZone,
    parsed,
  });

  if (!parsed.ok) {
    return {
      ok: false,
      reason: "invalid_datetime",
      availableTimes: [],
      suggestedStarts: [],
      timeZone,
    };
  }

  const parsedMeta = parsed as {
    hasExplicitDate?: unknown;
    hasExplicitTime?: unknown;
    confidence?: unknown;
  };

  const hasExplicitDate = parsedMeta.hasExplicitDate === true;
  const hasExplicitTime = parsedMeta.hasExplicitTime === true;
  const confidence = String(parsedMeta.confidence || "").trim().toLowerCase();

  if (!hasExplicitDate || !hasExplicitTime || confidence === "low") {
    console.warn("[VOICE][DATETIME_REJECTED_LOW_CONFIDENCE]", {
      tenantId: params.tenantId,
      serviceName: params.serviceName,
      rawDatetime: params.rawDatetime,
      timeZone,
      hasExplicitDate,
      hasExplicitTime,
      confidence,
      parsed,
    });

    return {
      ok: false,
      reason: "invalid_datetime",
      availableTimes: [],
      suggestedStarts: [],
      timeZone,
    };
  }

  const { rows: settingsRows } = await pool.query(
    `
      SELECT
        min_lead_minutes,
        default_duration_min,
        buffer_min
      FROM appointment_settings
      WHERE tenant_id = $1
      LIMIT 1
    `,
    [params.tenantId]
  );

  const minLeadMinutesRaw = Number(settingsRows?.[0]?.min_lead_minutes ?? 0);
  const minLeadMinutes =
    Number.isFinite(minLeadMinutesRaw) && minLeadMinutesRaw > 0
      ? minLeadMinutesRaw
      : 0;

  const defaultDurationMinRaw = Number(
    params.durationMin ?? settingsRows?.[0]?.default_duration_min ?? 30
  );

  const defaultDurationMin =
    Number.isFinite(defaultDurationMinRaw) && defaultDurationMinRaw > 0
      ? defaultDurationMinRaw
      : 30;

  const bufferMinRaw = Number(
    settingsRows?.[0]?.buffer_min ?? params.bufferMin ?? 0
  );
  const bufferMin =
    Number.isFinite(bufferMinRaw) && bufferMinRaw >= 0
      ? bufferMinRaw
      : 0;

  const findAlternatives =
    async (
      notBefore: Date
    ): Promise<string[]> => {
      const slots =
        await resolveVoiceBookableStartsForDate({
          tenantId:
            params.tenantId,

          serviceName:
            params.serviceName,

          targetDate:
            parsed.requestedAt,

          notBefore,

          channel:
            params.channel || "voice",

          baseDate:
            params.baseDate,

          timeZone,

          fieldServiceAreaEnabled:
            params.fieldServiceAreaEnabled === true,

          serviceAddress:
            params.serviceAddress,

          serviceLatitude:
            params.serviceLatitude,

          serviceLongitude:
            params.serviceLongitude,

          serviceFormattedAddress:
            params.serviceFormattedAddress,

          customerPhone:
            params.customerPhone,

          requestedResourceId:
            params.requestedResourceId,
        });

      return slots.map(
        (slot) => slot.startISO
      );
    };

  if (minLeadMinutes > 0) {
    const earliestAllowedAt =
      addMinutes(
        params.baseDate instanceof Date
          ? params.baseDate
          : new Date(),

        minLeadMinutes
      );

    if (
      parsed.requestedAt.getTime() <
      earliestAllowedAt.getTime()
    ) {
      const suggestedStarts =
        await findAlternatives(
          earliestAllowedAt
        );

      return {
        ok: false,
        reason:
          "lead_time_not_met",
        requestedAt:
          parsed.requestedAt,
        availableTimes: [],
        suggestedStarts,
        timeZone,
      };
    }
  }

  const scheduleValidation = await validateServiceScheduleForDate({
    tenantId: params.tenantId,
    serviceName: params.serviceName,
    requestedAt: parsed.requestedAt,
    channel: params.channel || "voice",
    timeZone,
    durationMin: defaultDurationMin,
    bufferMin,
    includeBufferInClosingBoundary: true,
  });

  console.log("[VOICE][SCHEDULE_CHECK]", {
    tenantId: params.tenantId,
    serviceName: params.serviceName,
    requestedAt: parsed.requestedAt.toISOString(),
    channel: params.channel || "voice",
    timeZone,
    scheduleValidation,
  });

  if (!scheduleValidation.ok) {
    const availableTimes =
      dedupeStringArray(
        Array.isArray(
          scheduleValidation.availableTimes
        )
          ? scheduleValidation.availableTimes
          : []
      );

    const suggestedStarts =
      await findAlternatives(
        parsed.requestedAt
      );

    return {
      ok: false,
      reason:
        "schedule_not_available",
      requestedAt:
        parsed.requestedAt,
      availableTimes,
      suggestedStarts,
      timeZone,
    };
  }

  const requestedEndAt = addMinutes(parsed.requestedAt, defaultDurationMin);
  const orchestrator = new BookingProviderOrchestrator();

  const requestedAvailability = await orchestrator.checkAvailability({
    tenantId: params.tenantId,
    summary: params.serviceName,
    startISO: parsed.requestedAt.toISOString(),
    endISO: requestedEndAt.toISOString(),
    timeZone,
    bufferMin,
    calendarId: null,
  });

  console.log("[VOICE][PROVIDER_AVAILABILITY_CHECK]", {
    tenantId: params.tenantId,
    serviceName: params.serviceName,
    startISO: parsed.requestedAt.toISOString(),
    endISO: requestedEndAt.toISOString(),
    timeZone,
    bufferMin,
    requestedAvailability,
  });

  if (!requestedAvailability.ok) {
    const providerError = String(
      (requestedAvailability as { error?: unknown }).error ?? ""
    )
      .trim()
      .toUpperCase();

    const shouldResolveSuggestions =
      providerError ===
        "SLOT_UNAVAILABLE" ||
      providerError ===
        "SLOT_BUSY" ||
      providerError ===
        "TIME_SLOT_UNAVAILABLE";

    const suggestedStarts =
      shouldResolveSuggestions
        ? await findAlternatives(
            parsed.requestedAt
          )
        : [];

    return {
      ok: false,
      reason:
        providerError === "PROVIDER_NOT_CONFIGURED"
          ? "provider_not_configured"
          : providerError === "PROVIDER_AUTH_REQUIRED"
            ? "provider_auth_required"
            : providerError === "PROVIDER_UNAVAILABLE"
              ? "provider_unavailable"
              : providerError === "SLOT_UNAVAILABLE" ||
                  providerError === "SLOT_BUSY" ||
                  providerError === "TIME_SLOT_UNAVAILABLE"
                ? "schedule_not_available"
                : "provider_check_failed",
      providerError: providerError || "UNKNOWN_PROVIDER_ERROR",
      requestedAt: parsed.requestedAt,
      availableTimes: [],
      suggestedStarts,
      timeZone,
    };
  }

    const routeValidation =
    await filterRouteAwareAvailability({
      tenantId:
        params.tenantId,

      fieldServiceAreaEnabled:
        params.fieldServiceAreaEnabled === true,

      address:
        params.serviceAddress,

      latitude:
        params.serviceLatitude,

      longitude:
        params.serviceLongitude,

      formattedAddress:
        params.serviceFormattedAddress,

      customerPhone:
        params.customerPhone,

      requestedResourceId:
        params.requestedResourceId,

      candidates: [
        {
          startISO:
            parsed.requestedAt.toISOString(),

          endISO:
            requestedEndAt.toISOString(),
        },
      ],

      maxResults: 1,
    });

  if (
    !routeValidation.ok ||
    routeValidation.slots.length === 0
  ) {
    const suggestedStarts =
      await findAlternatives(
        parsed.requestedAt
      );

    console.log(
      "[VOICE][ROUTE_SLOT_UNAVAILABLE]",
      {
        tenantId:
          params.tenantId,

        serviceName:
          params.serviceName,

        requestedAt:
          parsed.requestedAt.toISOString(),

        routeValidationOk:
          routeValidation.ok,

        routeRejected:
          routeValidation.ok
            ? routeValidation.rejected
            : routeValidation.error,

        suggestedStarts,
      }
    );

    return {
      ok: false,

      reason:
        "schedule_not_available",

      requestedAt:
        parsed.requestedAt,

      availableTimes: [],

      suggestedStarts,

      timeZone,
    };
  }
  
  return {
    ok: true,
    requestedAt: parsed.requestedAt,
    timeZone,
  };
}