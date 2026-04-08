import { BookingProviderRegistry } from "./registry";
import type { CreateExternalBookingInput, CreateExternalBookingResult } from "./types";

export class BookingProviderOrchestrator {
  private readonly registry: BookingProviderRegistry;

  constructor() {
    this.registry = new BookingProviderRegistry();
  }

  async createExternalBooking(
    input: CreateExternalBookingInput
  ): Promise<CreateExternalBookingResult> {
    // Fase 1: hard default controlado para no romper nada.
    // Más adelante esto sale de DB por tenant.
    const provider = "google_calendar" as const;

    const adapter = this.registry.get(provider);
    return adapter.createExternalBooking(input);
  }
}