//src/lib/appointments/booking/providers/types.ts
export type BookingProvider =
  | "google_calendar"
  | "square"
  | "glofox"
  | "booksy";

export type CreateExternalBookingInput = {
  tenantId: string;
  calendarId: string;
  summary: string;
  description?: string;
  startISO: string;
  endISO: string;
  timeZone: string;
  bufferMin: number;
};

export type CreateExternalBookingResult =
  | {
      ok: true;
      provider: BookingProvider;
      event_id: string;
      htmlLink: string | null;
      meetLink?: string | null;
    }
  | {
      ok: false;
      provider: BookingProvider;
      error:
        | "INVALID_DATETIME"
        | "FREEBUSY_DEGRADED"
        | "SLOT_BUSY"
        | "CREATE_EVENT_FAILED";
      busy: Array<{ start: string; end: string }>;
    };

export interface BookingProviderAdapter {
  readonly provider: BookingProvider;

  createExternalBooking(
    input: CreateExternalBookingInput
  ): Promise<CreateExternalBookingResult>;
}