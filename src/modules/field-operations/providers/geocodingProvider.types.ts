// src/modules/field-operations/providers/geocodingProvider.types.ts

export type GeocodingAddressComponent = {
  longName: string;
  shortName: string;
  types: string[];
};

export type GeocodingRequest = {
  address: string;
  language?: string;
  region?: string;
};

export type GeocodingResult = {
  formattedAddress: string;
  latitude: number;
  longitude: number;
  placeId: string | null;
  partialMatch: boolean;
  locationType: string | null;
  addressComponents: GeocodingAddressComponent[];
  providerMetadata: Record<string, unknown>;
};

export interface GeocodingProvider {
  readonly name: string;

  geocode(
    request: GeocodingRequest
  ): Promise<GeocodingResult | null>;
}