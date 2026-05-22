//src/lib/appointments/booking/providers/squareProvider.ts
import {
  getBookingProviderConnection,
  getBookingProviderSecrets,
} from "./providerConnections.repo";
import {
  squareCreateBooking,
  squareCreateCustomer,
  squareRetrieveBooking,
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

function splitCustomerName(fullName: unknown): {
  givenName: string;
  familyName: string;
} {
  const cleanName = cleanString(fullName);
  const parts = cleanName.split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return {
      givenName: "Customer",
      familyName: "",
    };
  }

  if (parts.length === 1) {
    return {
      givenName: parts[0],
      familyName: "",
    };
  }

  return {
    givenName: parts[0],
    familyName: parts.slice(1).join(" "),
  };
}

async function resolveSquareCustomerIdForBooking(args: {
  accessToken: string;
  environment: SquareEnvironment;
  existingCustomerId?: string | null;
  customer?: {
    name?: string | null;
    phone?: string | null;
    email?: string | null;
  };
}): Promise<string | null> {
  const existingCustomerId = cleanString(args.existingCustomerId);

  if (existingCustomerId) {
    return existingCustomerId;
  }

  const customerName = cleanString(args.customer?.name);
  const customerPhone = cleanString(args.customer?.phone);
  const customerEmail = cleanString(args.customer?.email);

  if (!customerName && !customerPhone && !customerEmail) {
    return null;
  }

  const { givenName, familyName } = splitCustomerName(customerName);

  const result = await squareCreateCustomer({
    accessToken: args.accessToken,
    environment: args.environment,
    givenName,
    familyName,
    email: customerEmail || null,
    phoneNumber: customerPhone || null,
  });

  if (!result.ok) {
    console.error("🟥 [SQUARE_PROVIDER] create customer failed", {
      status: result.status,
      error: result.error,
      details: JSON.stringify(result.details || {}, null, 2),
    });

    return null;
  }

  return cleanString(result.data.customer?.id) || null;
}

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

function normalizeMappingKey(value: unknown): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

async function resolveSquareMappingWithFallback(params: {
  tenantId: string;
  internalServiceKey: string;
}) {
  const exactResult = await resolveSquareServiceMappingFromDbForTenant({
    tenantId: params.tenantId,
    internalServiceKey: params.internalServiceKey,
  });

  if (exactResult.ok) {
    return exactResult;
  }

  console.warn("🟨 [SQUARE_PROVIDER] exact mapping lookup failed, trying normalized fallback", {
    tenantId: params.tenantId,
    internalServiceKey: params.internalServiceKey,
    exactError: exactResult.error,
    exactStatus: exactResult.status,
  });

  const candidates = [
    params.internalServiceKey,
    normalizeMappingKey(params.internalServiceKey),
  ];

  for (const candidate of candidates) {
    const cleanCandidate = String(candidate || "").trim();
    if (!cleanCandidate) continue;

    const result = await resolveSquareServiceMappingFromDbForTenant({
      tenantId: params.tenantId,
      internalServiceKey: cleanCandidate,
    });

    if (result.ok) {
      console.warn("🟨 [SQUARE_PROVIDER] mapping resolved with fallback key", {
        tenantId: params.tenantId,
        originalKey: params.internalServiceKey,
        fallbackKey: cleanCandidate,
      });

      return result;
    }
  }

  return exactResult;
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
    cleanString(metadata["location_id"]) ||
    cleanString(metadata["locationId"]);

  const customerId =
    cleanString(payload.customerId) ||
    cleanString(metadata["customer_id"]) ||
    cleanString(metadata["customerId"]) ||
    null;

  const teamMemberId =
    cleanString(payload.teamMemberId) ||
    cleanString(metadata["team_member_id"]) ||
    cleanString(metadata["teamMemberId"]);

  const serviceVariationId =
    cleanString(payload.serviceVariationId) ||
    cleanString(metadata["service_variation_id"]) ||
    cleanString(metadata["serviceVariationId"]) ||
    cleanString(metadata["variationId"]);

  const serviceVariationVersion =
    cleanNumber(payload.serviceVariationVersion) ??
    cleanNumber(metadata["service_variation_version"]) ??
    cleanNumber(metadata["serviceVariationVersion"]) ??
    cleanNumber(metadata["variationVersion"]);

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

  const mappingResult = await resolveSquareMappingWithFallback({
    tenantId: input.tenantId,
    internalServiceKey: input.summary,
  });

  if (!mappingResult.ok) {
    console.warn("🟨 [SQUARE_PROVIDER] mapping lookup failed", {
      tenantId: input.tenantId,
      summary: input.summary,
      error: mappingResult.error,
      status: mappingResult.status,
      details: mappingResult.details,
    });

    return directPayload;
  }

  const externalMetadata =
    mappingResult.mapping.externalMetadata &&
    typeof mappingResult.mapping.externalMetadata === "object"
      ? (mappingResult.mapping.externalMetadata as Record<string, unknown>)
      : {};

  return {
    locationId:
      directPayload.locationId ||
      cleanString(mappingResult.mapping.externalLocationId) ||
      cleanString(input.connectionLocationId) ||
      cleanString(input.metadata?.["location_id"]),
    customerId: directPayload.customerId,

    // Staff must only come from the booking flow / provider payload.
    // Service mappings resolve services, not staff assignment.
    teamMemberId: directPayload.teamMemberId,

    serviceVariationId:
      directPayload.serviceVariationId ||
      cleanString(mappingResult.mapping.externalServiceId) ||
      cleanString(externalMetadata["service_variation_id"]) ||
      cleanString(externalMetadata["serviceVariationId"]) ||
      cleanString(externalMetadata["variationId"]),
    serviceVariationVersion:
      directPayload.serviceVariationVersion ??
      cleanNumber(mappingResult.mapping.externalServiceVersion) ??
      cleanNumber(externalMetadata["service_variation_version"]) ??
      cleanNumber(externalMetadata["serviceVariationVersion"]) ??
      cleanNumber(externalMetadata["variationVersion"]) ??
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
  const customerPhone = cleanString(input.customer?.phone);
  const customerEmail = cleanString(input.customer?.email);
  const customerName = cleanString(input.customer?.name);
  const serviceVariationId = cleanString(input.providerPayload?.square?.serviceVariationId);
  const teamMemberId = cleanString(input.providerPayload?.square?.teamMemberId);

  return [
    "aamy",
    "square",
    input.tenantId,
    serviceVariationId || input.summary,
    input.startISO,
    teamMemberId || "any_staff",
    customerPhone || customerEmail || customerName || "unknown_customer",
  ]
    .map((part) => cleanString(part).replace(/\s+/g, "_"))
    .filter(Boolean)
    .join(":")
    .slice(0, 128);
}

function toTimeMs(value: unknown): number | null {
  const ms = new Date(String(value || "").trim()).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function sameInstant(left: unknown, right: unknown): boolean {
  const leftMs = toTimeMs(left);
  const rightMs = toTimeMs(right);

  return leftMs !== null && rightMs !== null && leftMs === rightMs;
}

async function verifySquareCreatedBooking(params: {
  tenantId: string;
  accessToken: string;
  environment: SquareEnvironment;
  squareBookingId: string;
  expectedLocationId: string;
  expectedCustomerId: string;
  expectedStartAt: string;
  expectedTeamMemberId: string;
  expectedServiceVariationId: string;
  expectedServiceVariationVersion: number;
}): Promise<
  | {
      ok: true;
      status: string;
    }
  | {
      ok: false;
      reason: string;
      details?: Record<string, unknown>;
    }
> {
  const retrieveResult = await squareRetrieveBooking({
    accessToken: params.accessToken,
    environment: params.environment,
    bookingId: params.squareBookingId,
  });

  if (!retrieveResult.ok) {
    return {
      ok: false,
      reason: "SQUARE_BOOKING_RETRIEVE_FAILED",
      details: {
        status: retrieveResult.status,
        error: retrieveResult.error,
        details: retrieveResult.details,
        squareErrors: retrieveResult.squareErrors,
      },
    };
  }

  const booking = retrieveResult.data.booking;

  if (!booking) {
    return {
      ok: false,
      reason: "SQUARE_BOOKING_NOT_RETURNED",
      details: {
        squareBookingId: params.squareBookingId,
        data: retrieveResult.data,
      },
    };
  }

  const retrievedBookingId = cleanString(booking.id);
  const retrievedLocationId = cleanString(booking.location_id);
  const retrievedCustomerId = cleanString(booking.customer_id);
  const retrievedStartAt = cleanString(booking.start_at);
  const retrievedStatus = cleanString(booking.status);

  if (retrievedBookingId !== params.squareBookingId) {
    return {
      ok: false,
      reason: "SQUARE_BOOKING_ID_MISMATCH",
      details: {
        expected: params.squareBookingId,
        received: retrievedBookingId,
      },
    };
  }

  if (retrievedLocationId !== params.expectedLocationId) {
    return {
      ok: false,
      reason: "SQUARE_BOOKING_LOCATION_MISMATCH",
      details: {
        expected: params.expectedLocationId,
        received: retrievedLocationId,
      },
    };
  }

  if (retrievedCustomerId !== params.expectedCustomerId) {
    return {
      ok: false,
      reason: "SQUARE_BOOKING_CUSTOMER_MISMATCH",
      details: {
        expected: params.expectedCustomerId,
        received: retrievedCustomerId,
      },
    };
  }

  if (!sameInstant(retrievedStartAt, params.expectedStartAt)) {
    return {
      ok: false,
      reason: "SQUARE_BOOKING_START_TIME_MISMATCH",
      details: {
        expected: params.expectedStartAt,
        received: retrievedStartAt,
      },
    };
  }

  const normalizedStatus = retrievedStatus.toUpperCase();

  if (
    normalizedStatus === "CANCELED" ||
    normalizedStatus === "CANCELLED" ||
    normalizedStatus === "DECLINED"
  ) {
    return {
      ok: false,
      reason: "SQUARE_BOOKING_NOT_ACTIVE",
      details: {
        status: retrievedStatus,
      },
    };
  }

  const segments = Array.isArray(booking.appointment_segments)
    ? booking.appointment_segments
    : [];

  const matchingSegment = segments.find((segment) => {
    const teamMemberId = cleanString(segment.team_member_id);
    const serviceVariationId = cleanString(segment.service_variation_id);
    const serviceVariationVersion = cleanNumber(
      segment.service_variation_version
    );

    return (
      teamMemberId === params.expectedTeamMemberId &&
      serviceVariationId === params.expectedServiceVariationId &&
      serviceVariationVersion === params.expectedServiceVariationVersion
    );
  });

  if (!matchingSegment) {
    return {
      ok: false,
      reason: "SQUARE_BOOKING_SEGMENT_MISMATCH",
      details: {
        expectedTeamMemberId: params.expectedTeamMemberId,
        expectedServiceVariationId: params.expectedServiceVariationId,
        expectedServiceVariationVersion:
          params.expectedServiceVariationVersion,
        receivedSegments: segments,
      },
    };
  }

  return {
    ok: true,
    status: retrievedStatus,
  };
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

    const requestedTeamMemberId = cleanString(squarePayload.teamMemberId) || null;

    console.log("🟦 [SQUARE_PROVIDER] availability request payload", {
      tenantId: input.tenantId,
      environment,
      startAt: input.startISO,
      endAt: availabilityEndISO,
      locationId: squarePayload.locationId,
      teamMemberId: requestedTeamMemberId,
      serviceVariationId: squarePayload.serviceVariationId,
    });

    const availabilityResult = await squareSearchAvailability({
      accessToken,
      environment,
      startAt: input.startISO,
      endAt: availabilityEndISO,
      locationId: squarePayload.locationId,
      teamMemberId: requestedTeamMemberId,
      serviceVariationId: squarePayload.serviceVariationId,
    });

    if (!availabilityResult.ok) {
      console.error("🟥 [SQUARE_PROVIDER] availability failed", {
        tenantId: input.tenantId,
        status: availabilityResult.status,
        error: availabilityResult.error,
        details: JSON.stringify(availabilityResult.details || {}, null, 2),
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

    const rawAvailabilities = Array.isArray(availabilityResult.data.availabilities)
      ? availabilityResult.data.availabilities
      : [];

    const availableStarts = rawAvailabilities
      .map((availability) => cleanString(availability.start_at))
      .filter(Boolean);

    console.log("🟦 [SQUARE_PROVIDER] availability response summary", {
      tenantId: input.tenantId,
      requestedStartISO: input.startISO,
      requestedStartMs: requestedStart,
      totalAvailabilities: rawAvailabilities.length,
      availableStarts: availableStarts.slice(0, 20),
      firstAvailabilities: rawAvailabilities.slice(0, 5).map((availability) => ({
        startAt: availability.start_at,
        locationId: availability.location_id,
        segments: availability.appointment_segments?.map((segment) => ({
          teamMemberId: segment.team_member_id,
          serviceVariationId: segment.service_variation_id,
          serviceVariationVersion: segment.service_variation_version,
          durationMinutes: segment.duration_minutes,
        })),
      })),
    });

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
      !squarePayload.serviceVariationId
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

    const availabilityEndISO = ensureMinimumSquareAvailabilityEndISO({
      startISO: input.startISO,
      endISO: input.endISO,
      minimumMinutes: 60,
    });

    const requestedTeamMemberId = cleanString(squarePayload.teamMemberId) || null;

    const exactAvailabilityResult = await squareSearchAvailability({
      accessToken,
      environment,
      startAt: input.startISO,
      endAt: availabilityEndISO,
      locationId: squarePayload.locationId,
      teamMemberId: requestedTeamMemberId,
      serviceVariationId: squarePayload.serviceVariationId,
    });

    if (!exactAvailabilityResult.ok) {
      console.error("🟥 [SQUARE_PROVIDER] exact availability fetch failed before create", {
        tenantId: input.tenantId,
        status: exactAvailabilityResult.status,
        error: exactAvailabilityResult.error,
        details: JSON.stringify(exactAvailabilityResult.details || {}, null, 2),
        squareErrors: JSON.stringify(exactAvailabilityResult.squareErrors || [], null, 2),
      });

      return {
        ok: false,
        provider: this.provider,
        error: "SLOT_BUSY",
        busy: [],
        suggestedStarts: [],
      };
    }

    const requestedStartMs = new Date(input.startISO).getTime();

    const exactAvailability = exactAvailabilityResult.data.availabilities?.find((slot) => {
      const slotStartMs = new Date(String(slot.start_at || "")).getTime();
      return Number.isFinite(slotStartMs) && slotStartMs === requestedStartMs;
    });

    const exactSegment = exactAvailability?.appointment_segments?.find((segment) => {
      const segmentTeamMemberId = cleanString(segment?.team_member_id);

      if (!requestedTeamMemberId) {
        return Boolean(segmentTeamMemberId);
      }

      return segmentTeamMemberId === requestedTeamMemberId;
    });

    const resolvedTeamMemberId =
      requestedTeamMemberId || cleanString(exactSegment?.team_member_id);

    const resolvedServiceVariationVersion =
      cleanNumber(exactSegment?.service_variation_version) ??
      squarePayload.serviceVariationVersion;

    const squareCustomerId = await resolveSquareCustomerIdForBooking({
      accessToken,
      environment,
      existingCustomerId: squarePayload.customerId,
      customer: input.customer,
    });

    if (!squareCustomerId) {
      return {
        ok: false,
        provider: this.provider,
        error: "CREATE_EVENT_FAILED",
        busy: [],
      };
    }

    if (!resolvedTeamMemberId || resolvedServiceVariationVersion == null) {
      return {
        ok: false,
        provider: this.provider,
        error: "PROVIDER_MAPPING_NOT_CONFIGURED",
        busy: [],
      };
    }

    const createResult = await squareCreateBooking({
      accessToken,
      environment,
      idempotencyKey: buildSquareIdempotencyKey(input),
      locationId: squarePayload.locationId,
      customerId: squareCustomerId,
      startAt: input.startISO,
      teamMemberId: resolvedTeamMemberId,
      serviceVariationId: squarePayload.serviceVariationId,
      serviceVariationVersion: resolvedServiceVariationVersion,
    });

    if (!createResult.ok) {
      const detailsText = JSON.stringify(createResult.details || {}, null, 2);

      console.error("🟥 [SQUARE_PROVIDER] create booking failed", {
        tenantId: input.tenantId,
        status: createResult.status,
        error: createResult.error,
        details: detailsText,
        squareErrors: JSON.stringify(createResult.squareErrors || [], null, 2),
      });

      const squareErrors = Array.isArray(createResult.squareErrors)
        ? createResult.squareErrors
        : [];

      const writeNotSupported = squareErrors.some((error) => {
        const detail = String(error.detail || "").toLowerCase();
        const code = String(error.code || "").toUpperCase();

        return (
          code === "FORBIDDEN" &&
          detail.includes("subscription") &&
          detail.includes("write operations")
        );
      });

      if (writeNotSupported) {
        return {
          ok: false,
          provider: this.provider,
          error: "SQUARE_WRITE_OPERATIONS_NOT_SUPPORTED",
          busy: [],
        };
      }

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

    const verification = await verifySquareCreatedBooking({
      tenantId: input.tenantId,
      accessToken,
      environment,
      squareBookingId,
      expectedLocationId: squarePayload.locationId,
      expectedCustomerId: squareCustomerId,
      expectedStartAt: input.startISO,
      expectedTeamMemberId: resolvedTeamMemberId,
      expectedServiceVariationId: squarePayload.serviceVariationId,
      expectedServiceVariationVersion: resolvedServiceVariationVersion,
    });

    if (!verification.ok) {
      console.error("🟥 [SQUARE_PROVIDER] booking verification failed after create", {
        tenantId: input.tenantId,
        squareBookingId,
        reason: verification.reason,
        details: JSON.stringify(verification.details || {}, null, 2),
      });

      return {
        ok: false,
        provider: this.provider,
        error: "CREATE_EVENT_FAILED",
        busy: [],
      };
    }

    console.log("✅ [SQUARE_PROVIDER] booking created and verified successfully", {
      tenantId: input.tenantId,
      squareBookingId,
      squareStatus: verification.status,
      startISO: input.startISO,
      locationId: squarePayload.locationId,
      teamMemberId: resolvedTeamMemberId,
      serviceVariationId: squarePayload.serviceVariationId,
      serviceVariationVersion: resolvedServiceVariationVersion,
      customerId: squareCustomerId,
    });

    return {
      ok: true,
      provider: this.provider,
      event_id: squareBookingId,
      htmlLink: null,
      meetLink: null,
    };
  }
}