import type { Pool } from "pg";
import type { CreateBookingInput, CreateBookingResult } from "./types";
import { BookingProviderRegistry } from "./registry";
import { resolveTenantBookingProvider } from "./resolveTenantBookingProvider";

type Deps = {
  pool: Pool;
};

export class BookingProviderOrchestrator {
  private readonly pool: Pool;
  private readonly registry: BookingProviderRegistry;

  constructor(deps: Deps) {
    this.pool = deps.pool;
    this.registry = new BookingProviderRegistry();
  }

  async createBooking(input: CreateBookingInput): Promise<CreateBookingResult> {
    const provider = await resolveTenantBookingProvider({
      pool: this.pool,
      tenantId: input.tenantId,
    });

    const adapter = this.registry.getAdapter(provider);
    return adapter.createBooking(input);
  }
}