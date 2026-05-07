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
        provider: "system",
        error: "PROVIDER_NOT_CONFIGURED",
        busy: [],
      };
    }

    const adapter = this.registry.get(provider);
    return adapter.createExternalBooking(input);
  }

  async checkAvailability(input: {
    tenantId: string;
    summary: string;
    startISO: string;
    endISO: string;
    timeZone: string;
    bufferMin: number;
    calendarId?: string | null;
  }): Promise<{
    ok: boolean;
    provider: string;
    error?: string;
    busy: Array<{ start: string; end?: string }>;
    suggestedStarts?: string[];
  }> {
    const provider = await resolveTenantBookingProvider(input.tenantId);

    if (!provider) {
      return {
        ok: false,
        provider: "system",
        error: "PROVIDER_NOT_CONFIGURED",
        busy: [],
        suggestedStarts: [],
      };
    }

    const adapter = this.registry.get(provider);

    if (typeof (adapter as any).checkAvailability !== "function") {
      return {
        ok: false,
        provider,
        error: "PROVIDER_AVAILABILITY_NOT_SUPPORTED",
        busy: [],
        suggestedStarts: [],
      };
    }

    return (adapter as any).checkAvailability(input);
  }
}