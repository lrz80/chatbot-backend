// src/modules/field-operations/providers/googleMapsGeocoding.provider.ts

import type {
  GeocodingAddressComponent,
  GeocodingProvider,
  GeocodingRequest,
  GeocodingResult,
} from "./geocodingProvider.types";

type GoogleAddressComponent = {
  long_name?: unknown;
  short_name?: unknown;
  types?: unknown;
};

type GoogleGeocodingResult = {
  formatted_address?: unknown;
  place_id?: unknown;
  partial_match?: unknown;
  address_components?: unknown;
  geometry?: {
    location?: {
      lat?: unknown;
      lng?: unknown;
    };
    location_type?: unknown;
  };
};

type GoogleGeocodingResponse = {
  status?: unknown;
  error_message?: unknown;
  results?: unknown;
  plus_code?: unknown;
};

function requiredString(
  value: unknown,
  fieldName: string
): string {
  const result = String(value ?? "").trim();

  if (!result) {
    throw new Error(
      `FIELD_OPERATIONS_REQUIRED_FIELD:${fieldName}`
    );
  }

  return result;
}

function optionalString(
  value: unknown
): string | undefined {
  const result = String(value ?? "").trim();
  return result || undefined;
}

function finiteCoordinate(
  value: unknown,
  minimum: number,
  maximum: number,
  fieldName: string
): number {
  const parsed = Number(value);

  if (
    !Number.isFinite(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(
      `FIELD_OPERATIONS_GOOGLE_MAPS_INVALID_${fieldName.toUpperCase()}`
    );
  }

  return parsed;
}

function parseAddressComponents(
  value: unknown
): GeocodingAddressComponent[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item)
    ) {
      return [];
    }

    const component =
      item as GoogleAddressComponent;

    const longName = optionalString(
      component.long_name
    );

    const shortName = optionalString(
      component.short_name
    );

    if (!longName || !shortName) {
      return [];
    }

    const types = Array.isArray(component.types)
      ? component.types
          .map((type) => optionalString(type))
          .filter((type): type is string => Boolean(type))
      : [];

    return [
      {
        longName,
        shortName,
        types,
      },
    ];
  });
}

function getApiKey(): string {
  return requiredString(
    process.env.GOOGLE_MAPS_API_KEY,
    "GOOGLE_MAPS_API_KEY"
  );
}

function getTimeoutMs(): number {
  const parsed = Number(
    process.env.GOOGLE_MAPS_GEOCODING_TIMEOUT_MS ??
      10_000
  );

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 10_000;
  }

  return Math.min(Math.round(parsed), 60_000);
}

export class GoogleMapsGeocodingProvider
  implements GeocodingProvider
{
  readonly name = "google_maps";

  async geocode(
    request: GeocodingRequest
  ): Promise<GeocodingResult | null> {
    const address = requiredString(
      request.address,
      "address"
    );

    const query = new URLSearchParams({
      address,
      key: getApiKey(),
    });

    const language = optionalString(
      request.language
    );

    const region = optionalString(request.region);

    if (language) {
      query.set("language", language);
    }

    if (region) {
      query.set("region", region);
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      getTimeoutMs()
    );

    try {
      const response = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?${query.toString()}`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
          },
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        throw new Error(
          `FIELD_OPERATIONS_GOOGLE_MAPS_HTTP_ERROR:${response.status}`
        );
      }

      const payload =
        (await response.json()) as GoogleGeocodingResponse;

      const status = requiredString(
        payload.status,
        "googleMapsStatus"
      );

      if (status === "ZERO_RESULTS") {
        return null;
      }

      if (status !== "OK") {
        const providerMessage = optionalString(
          payload.error_message
        );

        throw new Error(
          providerMessage
            ? `FIELD_OPERATIONS_GOOGLE_MAPS_${status}:${providerMessage}`
            : `FIELD_OPERATIONS_GOOGLE_MAPS_${status}`
        );
      }

      if (!Array.isArray(payload.results)) {
        throw new Error(
          "FIELD_OPERATIONS_GOOGLE_MAPS_INVALID_RESULTS"
        );
      }

      const firstResult = payload.results[0];

      if (
        !firstResult ||
        typeof firstResult !== "object" ||
        Array.isArray(firstResult)
      ) {
        return null;
      }

      const result =
        firstResult as GoogleGeocodingResult;

      const latitude = finiteCoordinate(
        result.geometry?.location?.lat,
        -90,
        90,
        "latitude"
      );

      const longitude = finiteCoordinate(
        result.geometry?.location?.lng,
        -180,
        180,
        "longitude"
      );

      return {
        formattedAddress: requiredString(
          result.formatted_address,
          "formattedAddress"
        ),
        latitude,
        longitude,
        placeId:
          optionalString(result.place_id) ?? null,
        partialMatch:
          result.partial_match === true,
        locationType:
          optionalString(
            result.geometry?.location_type
          ) ?? null,
        addressComponents:
          parseAddressComponents(
            result.address_components
          ),
        providerMetadata: {
          status,
          plusCode:
            payload.plus_code ?? null,
        },
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "AbortError"
      ) {
        throw new Error(
          "FIELD_OPERATIONS_GOOGLE_MAPS_TIMEOUT"
        );
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const googleMapsGeocodingProvider =
  new GoogleMapsGeocodingProvider();