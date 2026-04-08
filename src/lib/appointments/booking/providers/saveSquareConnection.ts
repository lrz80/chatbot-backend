import { squareRetrieveLocation, type SquareEnvironment } from "./square.client";
import {
  upsertBookingProviderConnection,
  type BookingProviderConnection,
} from "./providerConnections.repo";

type SaveSquareConnectionInput = {
  tenantId: string;
  accessToken: string;
  locationId: string;
  environment: SquareEnvironment;
};

type SaveSquareConnectionResult =
  | {
      ok: true;
      connection: BookingProviderConnection;
      squareLocation: {
        id: string | null;
        status: string | null;
        name: string | null;
        merchantId: string | null;
      };
    }
  | {
      ok: false;
      status: number;
      error: string;
      details?: unknown;
    };

export async function saveSquareConnection(
  input: SaveSquareConnectionInput
): Promise<SaveSquareConnectionResult> {
  const tenantId = String(input.tenantId || "").trim();
  const accessToken = String(input.accessToken || "").trim();
  const locationId = String(input.locationId || "").trim();
  const environment: SquareEnvironment =
    input.environment === "sandbox" ? "sandbox" : "production";

  if (!tenantId) {
    return {
      ok: false,
      status: 400,
      error: "TENANT_ID_REQUIRED",
    };
  }

  if (!accessToken) {
    return {
      ok: false,
      status: 400,
      error: "SQUARE_ACCESS_TOKEN_REQUIRED",
    };
  }

  if (!locationId) {
    return {
      ok: false,
      status: 400,
      error: "SQUARE_LOCATION_ID_REQUIRED",
    };
  }

  const locationResult = await squareRetrieveLocation({
    accessToken,
    environment,
    locationId,
  });

  if (!locationResult.ok) {
    await upsertBookingProviderConnection({
      tenantId,
      provider: "square",
      status: "error",
      externalLocationId: locationId,
      accessToken,
      metadata: {
        environment,
        last_error: locationResult.error,
        last_error_status: locationResult.status,
      },
    });

    return {
      ok: false,
      status: locationResult.status,
      error: locationResult.error,
      details: locationResult.details,
    };
  }

  const squareLocation = locationResult.data?.location;

  const connection = await upsertBookingProviderConnection({
    tenantId,
    provider: "square",
    status: "active",
    externalAccountId: squareLocation?.merchant_id ?? null,
    externalLocationId: squareLocation?.id ?? locationId,
    accessToken,
    metadata: {
      environment,
      location_name: squareLocation?.name ?? null,
      square_location_status: squareLocation?.status ?? null,
    },
  });

  return {
    ok: true,
    connection,
    squareLocation: {
      id: squareLocation?.id ?? null,
      status: squareLocation?.status ?? null,
      name: squareLocation?.name ?? null,
      merchantId: squareLocation?.merchant_id ?? null,
    },
  };
}