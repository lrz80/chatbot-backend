//src/lib/appointments/booking/providers/types.ts
export type BookingProvider =
  | "google_calendar"
  | "square"
  | "glofox"
  | "booksy";

export type BookingCustomer = {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  locale?: string | null;
};

export type SearchAvailabilityInput = {
  tenantId: string;
  from: string;
  to: string;
  timezone: string;
  serviceId?: string | null;
  staffId?: string | null;
  locationId?: string | null;
};

export type AvailabilitySlot = {
  startAt: string;
  endAt: string;
  provider: BookingProvider;
  serviceId?: string | null;
  staffId?: string | null;
  locationId?: string | null;
};

export type CreateBookingInput = {
  tenantId: string;
  appointmentId: string;
  channel: string;
  startAt: string;
  endAt: string;
  timezone: string;
  customer: BookingCustomer;
  serviceId?: string | null;
  staffId?: string | null;
  locationId?: string | null;
  externalCalendarId?: string | null;
  notes?: string | null;
};

export type CreateBookingResult = {
  bookingExternalId: string;
  status: "confirmed" | "pending" | "cancelled";
  startAt: string;
  endAt: string | null;
  provider: BookingProvider;
  raw?: unknown;
};

export interface BookingProviderAdapter {
  readonly provider: BookingProvider;

  searchAvailability?(
    input: SearchAvailabilityInput
  ): Promise<AvailabilitySlot[]>;

  createBooking(
    input: CreateBookingInput
  ): Promise<CreateBookingResult>;
}