import { getBookingProviderConnection } from "./providerConnections.repo";
import type {
  BookingProviderAdapter,
  CreateExternalBookingInput,
  CreateExternalBookingResult,
} from "./types";

export class SquareProvider implements BookingProviderAdapter {
  readonly provider = "square" as const;

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

    console.log("🟦 [SQUARE_PROVIDER] connection", {
      found: !!connection,
      status: connection?.status || null,
      hasAccessToken: !!String(connection?.access_token || "").trim(),
      externalLocationId: connection?.external_location_id || null,
      metadataLocationId: connection?.metadata?.["location_id"] || null,
    });

    if (!connection || connection.status !== "active") {
      console.log("🟥 [SQUARE_PROVIDER] no active connection");
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

    console.log("🟦 [SQUARE_PROVIDER] normalized credentials", {
      hasAccessToken: !!accessToken,
      locationId,
    });

    if (!accessToken || !locationId) {
      console.log("🟥 [SQUARE_PROVIDER] missing accessToken or locationId");
      return {
        ok: false,
        provider: this.provider,
        error: "CREATE_EVENT_FAILED",
        busy: [],
      };
    }

    console.log("🟨 [SQUARE_PROVIDER] STUB REACHED - connection is valid but booking is not implemented yet");

    return {
      ok: false,
      provider: this.provider,
      error: "CREATE_EVENT_FAILED",
      busy: [],
    };
  }
}