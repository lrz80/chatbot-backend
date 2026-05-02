//src/lib/appointments/booking/providers/types.ts
export type BookingProvider =
  | "google_calendar"
  | "square"
  | "glofox"
  | "booksy";

export type BookingProviderResultSource = BookingProvider | "system";

export type CreateExternalBookingInput = {
  tenantId: string;
  summary: string;
  description?: string;
  startISO: string;
  endISO: string;
  timeZone: string;
  bufferMin: number;

  /**
   * Contexto opcional del provider.
   * No todos los providers usan calendarId.
   * Google sí puede necesitarlo; otros providers pueden ignorarlo.
   */
  calendarId?: string | null;
};

export type CreateExternalBookingError =
  | "INVALID_DATETIME"
  | "FREEBUSY_DEGRADED"
  | "SLOT_BUSY"
  | "CREATE_EVENT_FAILED"
  | "PROVIDER_NOT_CONFIGURED";

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
      provider: BookingProviderResultSource;
      error: CreateExternalBookingError;
      busy: Array<{ start: string; end: string }>;
      suggestedStarts?: string[];
    };

export interface BookingProviderAdapter {
  readonly provider: BookingProvider;

  createExternalBooking(
    input: CreateExternalBookingInput
  ): Promise<CreateExternalBookingResult>;
}