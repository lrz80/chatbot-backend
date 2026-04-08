import type { BookingProvider, BookingProviderAdapter } from "./types";
import { GoogleCalendarProvider } from "./googleCalendarProvider";

export class BookingProviderRegistry {
  private readonly adapters: Map<BookingProvider, BookingProviderAdapter>;

  constructor() {
    const google = new GoogleCalendarProvider();

    this.adapters = new Map<BookingProvider, BookingProviderAdapter>([
      ["google_calendar", google],
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