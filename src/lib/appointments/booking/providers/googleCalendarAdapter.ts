//src/lib/appointments/booking/providers/googleCalendarAdapter.ts
import type {
  BookingProvider,
  BookingProviderAdapter,
  CreateBookingInput,
  CreateBookingResult,
} from "./types";
import { sendAppointmentToGoogleViaZapier } from "../../../../integrations/googleCalendar";

export class GoogleCalendarAdapter implements BookingProviderAdapter {
  public readonly provider: BookingProvider = "google_calendar";

  async createBooking(
    input: CreateBookingInput
  ): Promise<CreateBookingResult> {
    if (!input.externalCalendarId) {
      throw new Error("externalCalendarId is required for google_calendar provider");
    }

    await sendAppointmentToGoogleViaZapier(
      {
        id: input.appointmentId,
        tenant_id: input.tenantId,
        service_id: input.serviceId ?? null,
        channel: input.channel,
        customer_name: input.customer.name ?? null,
        customer_phone: input.customer.phone ?? null,
        customer_email: input.customer.email ?? null,
        start_time: input.startAt,
        end_time: input.endAt,
      },
      {
        id: input.externalCalendarId,
        tenant_id: input.tenantId,
        provider: "google",
        external_calendar_id: input.externalCalendarId,
        display_name: null,
      }
    );

    return {
      bookingExternalId: input.appointmentId,
      status: "confirmed",
      startAt: input.startAt,
      endAt: input.endAt ?? null,
      provider: "google_calendar",
      raw: {
        forwardedVia: "zapier",
        externalCalendarId: input.externalCalendarId,
      },
    };
  }
}