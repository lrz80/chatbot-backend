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

    // La conexión ya quedó validada y persistida en saveSquareConnection.ts.
    // El booking real por Square entra en el siguiente paso cuando
    // implementemos availability + service/team mapping.
    return {
      ok: false,
      provider: this.provider,
      error: "CREATE_EVENT_FAILED",
      busy: [],
    };
  }
}