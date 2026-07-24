// src/modules/field-operations/services/routeAwareAvailability.service.ts

import {
  geocodeFieldServiceBaseAddress,
  validateFieldServiceArea,
} from "./fieldServiceArea.service";

import {
  planFieldServiceBooking,
} from "./bookingPlanning.service";

export type RouteAwareAvailabilityCandidate = {
  startISO: string;
  endISO: string;
};

export type RouteAwareAvailableSlot = {
  startISO: string;
  endISO: string;

  resourceId: string;
  resourceName: string;

  latitude: number;
  longitude: number;

  formattedAddress: string;
};

export type FilterRouteAwareAvailabilityInput = {
  tenantId: string;

  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  formattedAddress?: string | null;

  customerPhone?: string | null;
  requestedResourceId?: string | null;

  candidates: RouteAwareAvailabilityCandidate[];

  /**
   * false:
   * El tenant no es field service y los horarios pasan sin
   * evaluación de ruta.
   *
   * true:
   * Cada candidato debe tener al menos un recurso con ruta viable.
   */
  fieldServiceAreaEnabled: boolean;

  maxResults?: number;
};

export type FilterRouteAwareAvailabilityResult =
  | {
      ok: true;

      fieldServiceApplied: false;

      slots: Array<
        RouteAwareAvailabilityCandidate & {
          resourceId: null;
          resourceName: null;
        }
      >;

      rejected: [];
    }
  | {
      ok: true;

      fieldServiceApplied: true;

      slots: RouteAwareAvailableSlot[];

      rejected: Array<{
        startISO: string;
        endISO: string;
        reason: string;
      }>;

      geocodedLocation: {
        latitude: number;
        longitude: number;
        formattedAddress: string;
      };
    }
  | {
      ok: false;

      fieldServiceApplied: true;

      error:
        | "FIELD_SERVICE_ADDRESS_REQUIRED"
        | "FIELD_SERVICE_ADDRESS_INVALID"
        | "FIELD_SERVICE_LOCATION_NOT_ALLOWED";

      slots: [];

      rejected: Array<{
        startISO: string;
        endISO: string;
        reason: string;
      }>;

      geocodedLocation?: {
        latitude: number;
        longitude: number;
        formattedAddress: string;
      };
    };

function clean(
  value: unknown
): string {
  return String(value ?? "").trim();
}

function validCoordinate(
  value: unknown,
  minimum: number,
  maximum: number
): number | null {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const parsed = Number(value);

  if (
    !Number.isFinite(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    return null;
  }

  return parsed;
}

function normalizeCandidates(
  candidates: RouteAwareAvailabilityCandidate[]
): RouteAwareAvailabilityCandidate[] {
  const seen = new Set<string>();

  const normalized:
    RouteAwareAvailabilityCandidate[] = [];

  for (const candidate of candidates) {
    const startISO =
      clean(candidate.startISO);

    const endISO =
      clean(candidate.endISO);

    if (!startISO || !endISO) {
      continue;
    }

    const start =
      new Date(startISO);

    const end =
      new Date(endISO);

    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      end.getTime() <= start.getTime()
    ) {
      continue;
    }

    const key =
      `${start.toISOString()}|${end.toISOString()}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    normalized.push({
      startISO:
        start.toISOString(),

      endISO:
        end.toISOString(),
    });
  }

  normalized.sort(
    (first, second) =>
      new Date(first.startISO).getTime() -
      new Date(second.startISO).getTime()
  );

  return normalized;
}

export async function filterRouteAwareAvailability(
  input: FilterRouteAwareAvailabilityInput
): Promise<FilterRouteAwareAvailabilityResult> {
  const tenantId =
    clean(input.tenantId);

  if (!tenantId) {
    throw new Error(
      "FIELD_OPERATIONS_REQUIRED_FIELD:tenantId"
    );
  }

  const maxResults =
    Number.isFinite(
      Number(input.maxResults)
    )
      ? Math.max(
          1,
          Math.floor(
            Number(input.maxResults)
          )
        )
      : 3;

  const candidates =
    normalizeCandidates(
      input.candidates
    );

  if (!input.fieldServiceAreaEnabled) {
    return {
      ok: true,

      fieldServiceApplied: false,

      slots:
        candidates
          .slice(0, maxResults)
          .map((candidate) => ({
            ...candidate,

            resourceId: null,
            resourceName: null,
          })),

      rejected: [],
    };
  }

  let latitude =
    validCoordinate(
      input.latitude,
      -90,
      90
    );

  let longitude =
    validCoordinate(
      input.longitude,
      -180,
      180
    );

  let formattedAddress =
    clean(input.formattedAddress);

  const address =
    clean(input.address);

  if (
    latitude === null ||
    longitude === null
  ) {
    if (!address) {
      return {
        ok: false,

        fieldServiceApplied: true,

        error:
          "FIELD_SERVICE_ADDRESS_REQUIRED",

        slots: [],

        rejected:
          candidates.map(
            (candidate) => ({
              ...candidate,

              reason:
                "FIELD_SERVICE_ADDRESS_REQUIRED",
            })
          ),
      };
    }

    try {
      const geocoded =
        await geocodeFieldServiceBaseAddress({
          address,
        });

      latitude =
        geocoded.latitude;

      longitude =
        geocoded.longitude;

      formattedAddress =
        clean(
          geocoded.formattedAddress
        ) || address;
    } catch (error) {
      console.error(
        "[FIELD_OPERATIONS][ROUTE_AWARE_ADDRESS_GEOCODING_FAILED]",
        {
          tenantId,
          address,

          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );

      return {
        ok: false,

        fieldServiceApplied: true,

        error:
          "FIELD_SERVICE_ADDRESS_INVALID",

        slots: [],

        rejected:
          candidates.map(
            (candidate) => ({
              ...candidate,

              reason:
                "FIELD_SERVICE_ADDRESS_INVALID",
            })
          ),
      };
    }
  }

  if (!formattedAddress) {
    formattedAddress =
      address ||
      `${latitude},${longitude}`;
  }

  const areaValidation =
    await validateFieldServiceArea({
      tenantId,
      latitude,
      longitude,
    });

  if (!areaValidation.allowed) {
    return {
      ok: false,

      fieldServiceApplied: true,

      error:
        "FIELD_SERVICE_LOCATION_NOT_ALLOWED",

      slots: [],

      rejected:
        candidates.map(
          (candidate) => ({
            ...candidate,

            reason:
              areaValidation.reason ||
              "FIELD_SERVICE_LOCATION_NOT_ALLOWED",
          })
        ),

      geocodedLocation: {
        latitude,
        longitude,
        formattedAddress,
      },
    };
  }

  const slots:
    RouteAwareAvailableSlot[] = [];

  const rejected:
    Array<{
      startISO: string;
      endISO: string;
      reason: string;
    }> = [];

  /*
   * Secuencial intencionalmente:
   *
   * - evita saturar PostgreSQL;
   * - evita ejecutar varias simulaciones sobre el mismo técnico;
   * - permite detenernos cuando ya tenemos suficientes opciones.
   */
  for (const candidate of candidates) {
    if (
      slots.length >= maxResults
    ) {
      break;
    }

    const planning =
      await planFieldServiceBooking({
        tenantId,

        startAt:
          candidate.startISO,

        endAt:
          candidate.endISO,

        latitude,
        longitude,

        customerPhone:
          clean(
            input.customerPhone
          ) || null,

        requestedResourceId:
          clean(
            input.requestedResourceId
          ) || null,
      });

    if (!planning.ok) {
      rejected.push({
        startISO:
          candidate.startISO,

        endISO:
          candidate.endISO,

        reason:
          planning.error,
      });

      continue;
    }

    slots.push({
      startISO:
        candidate.startISO,

      endISO:
        candidate.endISO,

      resourceId:
        planning.resourceId,

      resourceName:
        planning.resourceName,

      latitude,
      longitude,

      formattedAddress,
    });
  }

  console.log(
    "[FIELD_OPERATIONS][ROUTE_AWARE_AVAILABILITY_FILTERED]",
    {
      tenantId,

      candidates:
        candidates.length,

      accepted:
        slots.length,

      rejected:
        rejected.length,

      requestedResourceId:
        clean(
          input.requestedResourceId
        ) || null,
    }
  );

  return {
    ok: true,

    fieldServiceApplied: true,

    slots,
    rejected,

    geocodedLocation: {
      latitude,
      longitude,
      formattedAddress,
    },
  };
}