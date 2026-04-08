import { getBookingProviderConnection } from "./providerConnections.repo";
import { squareRetrieveLocation } from "./square.client";
import type {
  BookingProviderAdapter,
  CreateExternalBookingInput,
  CreateExternalBookingResult,
} from "./types";

type SquareEnvironment = "sandbox" | "production";

function resolveSquareEnvironment(
  metadata: Record<string, unknown>
): SquareEnvironment {
  const raw = String(
    metadata["environment"] ||
      process.env.SQUARE_ENVIRONMENT ||
      "production"
  )
    .trim()
    .toLowerCase();

  return raw === "sandbox" ? "sandbox" : "production";
}

export class SquareProvider implements BookingProviderAdapter {
  readonly provider = "square" as const;

  async createExternalBooking(
    input: CreateExternalBookingInput
  ): Promise<CreateExternalBookingResult> {
    const connection = await getBookingProviderConnection(
      input.tenantId,
      this.provider
    );

    if (!connection || connection.status !== "active") {
      return {
        ok: false,
        provider: this.provider,
        error: "CREATE_EVENT_FAILED",
        busy: [],
      };
    }

    const accessToken = String(connection.access_token || "").trim();
    const locationId =
      String(connection.external_location_id || "").trim() ||
      String(connection.metadata?.["location_id"] || "").trim();

    if (!accessToken || !locationId) {
      return {
        ok: false,
        provider: this.provider,
        error: "CREATE_EVENT_FAILED",
        busy: [],
      };
    }

    const environment = resolveSquareEnvironment(connection.metadata);

    const locationResult = await squareRetrieveLocation({
      accessToken,
      environment,
      locationId,
    });

    if (!locationResult.ok) {
      console.error("[SQUARE_PROVIDER] connection validation failed", {
        tenantId: input.tenantId,
        status: locationResult.status,
        error: locationResult.error,
        details: locationResult.details,
      });

      return {
        ok: false,
        provider: this.provider,
        error: "CREATE_EVENT_FAILED",
        busy: [],
      };
    }

    console.log("[SQUARE_PROVIDER] connection validated", {
      tenantId: input.tenantId,
      locationId,
      environment,
      squareLocationId: locationResult.data?.location?.id ?? null,
      squareLocationStatus: locationResult.data?.location?.status ?? null,
    });

    return {
      ok: false,
      provider: this.provider,
      error: "CREATE_EVENT_FAILED",
      busy: [],
    };
  }
}