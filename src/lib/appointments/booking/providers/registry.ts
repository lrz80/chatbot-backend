import type { BookingProvider, BookingProviderAdapter } from "./types";
import { GoogleCalendarAdapter } from "./googleCalendarAdapter";

export class BookingProviderRegistry {
  private readonly adapters: Map<BookingProvider, BookingProviderAdapter>;

  constructor() {
    const googleAdapter = new GoogleCalendarAdapter();

    this.adapters = new Map<BookingProvider, BookingProviderAdapter>([
      ["google_calendar", googleAdapter],
    ]);
  }

  getAdapter(provider: BookingProvider): BookingProviderAdapter {
    const adapter = this.adapters.get(provider);

    if (!adapter) {
      throw new Error(`Booking provider adapter not found: ${provider}`);
    }

    return adapter;
  }
}