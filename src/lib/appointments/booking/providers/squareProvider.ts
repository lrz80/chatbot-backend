import type {
  BookingProviderAdapter,
  CreateExternalBookingInput,
  CreateExternalBookingResult,
} from "./types";

export class SquareProvider implements BookingProviderAdapter {
  readonly provider = "square" as const;

  async createExternalBooking(
    _input: CreateExternalBookingInput
  ): Promise<CreateExternalBookingResult> {
    return {
      ok: false,
      provider: this.provider,
      error: "CREATE_EVENT_FAILED",
      busy: [],
    };
  }
}