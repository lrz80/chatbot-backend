//src/lib/appointments/booking/providers/squareProvider.ts
import {
  getBookingProviderConnection,
  getBookingProviderSecrets,
} from "./providerConnections.repo";
import {
  squareCreateBooking,
  squareSearchAvailability,
  type SquareEnvironment,
} from "./square.client";
import type {
  BookingProviderAdapter,
  CheckExternalAvailabilityInput,
  CheckExternalAvailabilityResult,
  CreateExternalBookingInput,
  CreateExternalBookingResult,
  SquareBookingPayload,
} from "./types";
import { resolveSquareServiceMappingFromDbForTenant } from "../../../integrations/square/resolveSquareServiceMappingFromDbForTenant";

function resolveSquareEnvironment(value: unknown): SquareEnvironment {
  return value === "sandbox" ? "sandbox" : "production";
}

function cleanString(value: unknown): string {
  return String(value || "").trim();
}

function cleanNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const parsed = Number(String(value || "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveSquarePayload(input: {
  connectionLocationId?: string | null;
  metadata?: Record<string, unknown>;
  payload?: SquareBookingPayload;
}): {
  locationId: string;
  customerId: string | null;
  teamMemberId: string;
  serviceVariationId: string;
  serviceVariationVersion: number | null;
} {
  const metadata = input.metadata || {};
  const payload = input.payload || {};

  const locationId =
    cleanString(payload.locationId) ||
    cleanString(input.connectionLocationId) ||
    cleanString(metadata["location_id"]);

  const customerId =
    cleanString(payload.customerId) ||
    cleanString(metadata["customer_id"]) ||
    null;

  const teamMemberId =
    cleanString(payload.teamMemberId) ||
    cleanString(metadata["team_member_id"]);

  const serviceVariationId =
    cleanString(payload.serviceVariationId) ||
    cleanString(metadata["service_variation_id"]);

  const serviceVariationVersion =
    cleanNumber(payload.serviceVariationVersion) ??
    cleanNumber(metadata["service_variation_version"]);

  return {
    locationId,
    customerId,
    teamMemberId,
    serviceVariationId,
    serviceVariationVersion,
  };
}

async function resolveSquarePayloadForInput(input: {
  tenantId: string;
  summary: string;
  connectionLocationId?: string | null;
  metadata?: Record<string, unknown>;
  payload?: SquareBookingPayload;
}): Promise<{
  locationId: string;
  customerId: string | null;
  teamMemberId: string;
  serviceVariationId: string;
  serviceVariationVersion: number | null;
}> {
  const directPayload = resolveSquarePayload({
    connectionLocationId: input.connectionLocationId,
    metadata: input.metadata,
    payload: input.payload,
  });

  if (
    directPayload.teamMemberId &&
    directPayload.serviceVariationId &&
    directPayload.serviceVariationVersion != null
  ) {
    return directPayload;
  }

  const mappingResult = await resolveSquareServiceMappingFromDbForTenant({
    tenantId: input.tenantId,
    internalServiceKey: input.summary,
  });

  if (!mappingResult.ok) {
    return directPayload;
  }

  const mappedTeamMemberId = cleanString(
    mappingResult.mapping.externalMetadata?.team_member_id
  );

  return {
    locationId:
      directPayload.locationId ||
      cleanString(mappingResult.mapping.externalLocationId) ||
      cleanString(input.connectionLocationId) ||
      cleanString(input.metadata?.["location_id"]),
    customerId: directPayload.customerId,
    teamMemberId: directPayload.teamMemberId || mappedTeamMemberId,
    serviceVariationId:
      directPayload.serviceVariationId ||
      cleanString(mappingResult.mapping.externalServiceId),
    serviceVariationVersion:
      directPayload.serviceVariationVersion ??
      mappingResult.mapping.externalServiceVersion ??
      cleanNumber(mappingResult.service.variationVersion),
  };
}

function ensureMinimumSquareAvailabilityEndISO(params: {
  startISO: string;
  endISO: string;
  minimumMinutes?: number;
}): string {
  const start = new Date(params.startISO);
  const end = new Date(params.endISO);
  const minimumMinutes = params.minimumMinutes ?? 60;

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return params.endISO;
  }

  const minimumEnd = new Date(start.getTime() + minimumMinutes * 60 * 1000);

  return end.getTime() < minimumEnd.getTime()
    ? minimumEnd.toISOString()
    : end.toISOString();
}

function buildSquareIdempotencyKey(input: CreateExternalBookingInput): string {
  return [
    "aamy",
    "square",
    input.tenantId,
    input.summary,
    input.startISO,
  ]
    .map((part) => cleanString(part).replace(/\s+/g, "_"))
    .filter(Boolean)
    .join(":")
    .slice(0, 128);
}

export class SquareProvider implements BookingProviderAdapter {
  readonly provider = "square" as const;

  async checkAvailability(
    input: CheckExternalAvailabilityInput
  ): Promise<CheckExternalAvailabilityResult> {
    console.log("🟦 [SQUARE_PROVIDER] ENTER checkAvailability", {
      tenantId: input.tenantId,
      startISO: input.startISO,
      endISO: input.endISO,
      timeZone: input.timeZone,
    });

    const connection = await getBookingProviderConnection(
      input.tenantId,
      this.provider
    );

    if (!connection || connection.status !== "active") {
      return {
        ok: false,
        provider: this.provider,
        error: "PROVIDER_NOT_CONFIGURED",
        busy: [],
        suggestedStarts: [],
      };
    }

    const secrets = await getBookingProviderSecrets(input.tenantId, this.provider);
    const accessToken = cleanString(secrets?.accessToken);
    const environment = resolveSquareEnvironment(connection.metadata?.["environment"]);

    const squarePayload = await resolveSquarePayloadForInput({
      tenantId: input.tenantId,
      summary: input.summary,
      connectionLocationId: connection.external_location_id,
      metadata: connection.metadata,
      payload: input.providerPayload?.square,
    });

    if (
      !accessToken ||
      !squarePayload.locationId ||
      !squarePayload.teamMemberId ||
      !squarePayload.serviceVariationId
    ) {
      console.warn("🟥 [SQUARE_PROVIDER] missing Square availability mapping", {
        tenantId: input.tenantId,
        hasAccessToken: Boolean(accessToken),
        hasLocationId: Boolean(squarePayload.locationId),
        hasTeamMemberId: Boolean(squarePayload.teamMemberId),
        hasServiceVariationId: Boolean(squarePayload.serviceVariationId),
      });

      return {
        ok: false,
        provider: this.provider,
        error: "PROVIDER_MAPPING_NOT_CONFIGURED",
        busy: [],
        suggestedStarts: [],
      };
    }

    const availabilityEndISO = ensureMinimumSquareAvailabilityEndISO({
      startISO: input.startISO,
      endISO: input.endISO,
      minimumMinutes: 60,
    });

    const availabilityResult = await squareSearchAvailability({
      accessToken,
      environment,
      startAt: input.startISO,
      endAt: availabilityEndISO,
      locationId: squarePayload.locationId,
      teamMemberId: squarePayload.teamMemberId,
      serviceVariationId: squarePayload.serviceVariationId,
    });

    if (!availabilityResult.ok) {
      console.error("🟥 [SQUARE_PROVIDER] availability failed", {
        tenantId: input.tenantId,
        status: availabilityResult.status,
        error: availabilityResult.error,
        details: availabilityResult.details,
      });

      return {
        ok: false,
        provider: this.provider,
        error: "FREEBUSY_DEGRADED",
        busy: [],
        suggestedStarts: [],
      };
    }

    const requestedStart = new Date(input.startISO).getTime();

    const availableStarts = Array.isArray(availabilityResult.data.availabilities)
      ? availabilityResult.data.availabilities
          .map((availability) => cleanString(availability.start_at))
          .filter(Boolean)
      : [];

    const exactSlotAvailable = availableStarts.some((startAt) => {
      const slotStart = new Date(startAt).getTime();
      return Number.isFinite(slotStart) && slotStart === requestedStart;
    });

    if (!exactSlotAvailable) {
      return {
        ok: false,
        provider: this.provider,
        error: "SLOT_BUSY",
        busy: [
          {
            start: input.startISO,
            end: input.endISO,
          },
        ],
        suggestedStarts: availableStarts.slice(0, 12),
      };
    }

    return {
      ok: true,
      provider: this.provider,
      busy: [],
      suggestedStarts: [],
    };
  }

  async createExternalBooking(
    input: CreateExternalBookingInput
  ): Promise<CreateExternalBookingResult> {
    console.log("🟦 [SQUARE_PROVIDER] ENTER createExternalBooking", {
      tenantId: input.tenantId,
      startISO: input.startISO,
      endISO: input.endISO,
      timeZone: input.timeZone,
    });

    const connection = await getBookingProviderConnection(
      input.tenantId,
      this.provider
    );

    if (!connection || connection.status !== "active") {
      console.log("🟥 [SQUARE_PROVIDER] no active connection");

      return {
        ok: false,
        provider: this.provider,
        error: "PROVIDER_NOT_CONFIGURED",
        busy: [],
      };
    }

    const secrets = await getBookingProviderSecrets(input.tenantId, this.provider);
    const accessToken = cleanString(secrets?.accessToken);
    const environment = resolveSquareEnvironment(connection.metadata?.["environment"]);

    const squarePayload = await resolveSquarePayloadForInput({
      tenantId: input.tenantId,
      summary: input.summary,
      connectionLocationId: connection.external_location_id,
      metadata: connection.metadata,
      payload: input.providerPayload?.square,
    });

    console.log("🟦 [SQUARE_PROVIDER] normalized Square payload", {
      tenantId: input.tenantId,
      hasAccessToken: Boolean(accessToken),
      locationId: squarePayload.locationId,
      hasCustomerId: Boolean(squarePayload.customerId),
      teamMemberId: squarePayload.teamMemberId,
      serviceVariationId: squarePayload.serviceVariationId,
      serviceVariationVersion: squarePayload.serviceVariationVersion,
      environment,
    });

    if (
      !accessToken ||
      !squarePayload.locationId ||
      !squarePayload.teamMemberId ||
      !squarePayload.serviceVariationId ||
      squarePayload.serviceVariationVersion == null
    ) {
      return {
        ok: false,
        provider: this.provider,
        error: "PROVIDER_MAPPING_NOT_CONFIGURED",
        busy: [],
      };
    }

    const availability = await this.checkAvailability({
      tenantId: input.tenantId,
      summary: input.summary,
      startISO: input.startISO,
      endISO: input.endISO,
      timeZone: input.timeZone,
      bufferMin: input.bufferMin,
      calendarId: input.calendarId ?? null,
      providerPayload: input.providerPayload,
    });

    if (!availability.ok) {
      return {
        ok: false,
        provider: this.provider,
        error: availability.error ?? "SLOT_BUSY",
        busy: availability.busy,
        suggestedStarts: availability.suggestedStarts || [],
      };
    }

    const createResult = await squareCreateBooking({
      accessToken,
      environment,
      idempotencyKey: buildSquareIdempotencyKey(input),
      locationId: squarePayload.locationId,
      customerId: squarePayload.customerId,
      startAt: input.startISO,
      teamMemberId: squarePayload.teamMemberId,
      serviceVariationId: squarePayload.serviceVariationId,
      serviceVariationVersion: squarePayload.serviceVariationVersion,
    });

    if (!createResult.ok) {
      console.error("🟥 [SQUARE_PROVIDER] create booking failed", {
        tenantId: input.tenantId,
        status: createResult.status,
        error: createResult.error,
        details: createResult.details,
      });

      return {
        ok: false,
        provider: this.provider,
        error: "CREATE_EVENT_FAILED",
        busy: [],
      };
    }

    const squareBookingId = String(createResult.data.booking?.id || "").trim();

    if (!squareBookingId) {
      console.error("🟥 [SQUARE_PROVIDER] create booking returned without booking id", {
        tenantId: input.tenantId,
        status: createResult.status,
        data: createResult.data,
      });

      return {
        ok: false,
        provider: this.provider,
        error: "CREATE_EVENT_FAILED",
        busy: [],
      };
    }

    return {
      ok: true,
      provider: this.provider,
      event_id: squareBookingId,
      htmlLink: null,
      meetLink: null,
    };
  }
}