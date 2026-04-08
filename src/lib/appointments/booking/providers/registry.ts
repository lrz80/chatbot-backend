//src/lib/appointments/booking/providers/registry.ts
import type { BookingProvider, BookingProviderAdapter } from "./types";
import { GoogleCalendarProvider } from "./googleCalendarProvider";
import { SquareProvider } from "./squareProvider";

export class BookingProviderRegistry {
  private readonly adapters: Map<BookingProvider, BookingProviderAdapter>;

  constructor() {
    const google = new GoogleCalendarProvider();
    const square = new SquareProvider();

    this.adapters = new Map<BookingProvider, BookingProviderAdapter>([
      ["google_calendar", google],
      ["square", square],
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