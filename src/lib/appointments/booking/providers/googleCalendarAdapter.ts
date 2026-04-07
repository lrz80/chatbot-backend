//src/lib/appointments/booking/providers/googleCalendarAdapter.ts
import type {
  AvailabilitySlot,
  BookingProvider,
  BookingProviderAdapter,
  CreateBookingInput,
  CreateBookingResult,
  SearchAvailabilityInput,
} from "./types";

import {
  searchGoogleCalendarAvailability,
  createGoogleCalendarBooking,
} from "../../../../integrations/googleCalendar";

export class GoogleCalendarAdapter implements BookingProviderAdapter {
  public readonly provider: BookingProvider = "google_calendar";

  async searchAvailability(
    input: SearchAvailabilityInput
  ): Promise<AvailabilitySlot[]> {
    const slots = await searchGoogleCalendarAvailability(input);

    return slots.map((slot: { startAt: string; endAt: string }) => ({
      startAt: slot.startAt,
      endAt: slot.endAt,
      provider: "google_calendar",
      serviceId: input.serviceId ?? null,
      staffId: input.staffId ?? null,
      locationId: input.locationId ?? null,
    }));
  }

  async createBooking(
    input: CreateBookingInput
  ): Promise<CreateBookingResult> {
    const result = await createGoogleCalendarBooking(input);

    return {
      bookingExternalId: result.bookingExternalId,
      status: result.status,
      startAt: result.startAt,
      endAt: result.endAt ?? null,
      provider: "google_calendar",
      raw: result,
    };
  }
}