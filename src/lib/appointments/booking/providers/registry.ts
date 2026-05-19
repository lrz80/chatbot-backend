//src/lib/appointments/booking/providers/registry.ts
import type {
  BookingProvider,
  BookingProviderAdapter,
  CreateExternalBookingInput,
  CreateExternalBookingResult,
} from "./types";
import { GoogleCalendarProvider } from "./googleCalendarProvider";
import { SquareProvider } from "./squareProvider";

class NotImplementedBookingProvider implements BookingProviderAdapter {
  constructor(readonly provider: BookingProvider) {}

  async createExternalBooking(
    _input: CreateExternalBookingInput
  ): Promise<CreateExternalBookingResult> {
    return {
      ok: false,
      provider: this.provider,
      error: "PROVIDER_NOT_CONFIGURED",
      busy: [],
    };
  }
}

export class BookingProviderRegistry {
  private readonly adapters: Map<BookingProvider, BookingProviderAdapter>;

  constructor() {
    const google = new GoogleCalendarProvider();
    const square = new SquareProvider();
    const moego = new NotImplementedBookingProvider("moego");

    this.adapters = new Map<BookingProvider, BookingProviderAdapter>([
      ["google_calendar", google],
      ["square", square],
      ["moego", moego],
    ]);
  }

  get(provider: BookingProvider): BookingProviderAdapter {
    const adapter = this.adapters.get(provider);

    if (!adapter) {
      throw new Error(`Booking provider adapter not found: ${provider}`);
    }

    return adapter;
  }
}