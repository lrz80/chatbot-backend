//src/lib/appointments/booking/providers/orchestrator.ts
import { BookingProviderRegistry } from "./registry";
import { resolveTenantBookingProvider } from "./resolveTenantBookingProvider";
import type {
  CreateExternalBookingInput,
  CreateExternalBookingResult,
} from "./types";

export class BookingProviderOrchestrator {
  private readonly registry: BookingProviderRegistry;

  constructor() {
    this.registry = new BookingProviderRegistry();
  }

  async createExternalBooking(
    input: CreateExternalBookingInput
  ): Promise<CreateExternalBookingResult> {
    const provider = await resolveTenantBookingProvider(input.tenantId);

    if (!provider) {
      return {
        ok: false,
        provider: "google_calendar",
        error: "CREATE_EVENT_FAILED",
        busy: [],
      };
    }

    const adapter = this.registry.get(provider);
    return adapter.createExternalBooking(input);
  }
}