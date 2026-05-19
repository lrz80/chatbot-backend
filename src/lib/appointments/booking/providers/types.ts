//src/lib/appointments/booking/providers/types.ts
export type BookingProvider =
  | "google_calendar"
  | "square"
  | "moego"
  | "glofox"
  | "booksy";

export type BookingProviderResultSource = BookingProvider | "system";

export type SquareBookingPayload = {
  locationId?: string | null;
  customerId?: string | null;
  teamMemberId?: string | null;
  serviceVariationId?: string | null;
  serviceVariationVersion?: number | string | null;
};

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
   * Google puede usar calendarId.
   * Otros providers pueden ignorarlo.
   */
  calendarId?: string | null;

  /**
   * Payload genérico por provider.
   * No hardcodea negocios ni tenants.
   */
  providerPayload?: {
    square?: SquareBookingPayload;
  };
};

export type CheckExternalAvailabilityInput = {
  tenantId: string;
  summary: string;
  startISO: string;
  endISO: string;
  timeZone: string;
  bufferMin: number;
  calendarId?: string | null;
  providerPayload?: CreateExternalBookingInput["providerPayload"];
};

export type CreateExternalBookingError =
  | "INVALID_DATETIME"
  | "FREEBUSY_DEGRADED"
  | "SLOT_BUSY"
  | "CREATE_EVENT_FAILED"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_AVAILABILITY_NOT_SUPPORTED"
  | "PROVIDER_MAPPING_NOT_CONFIGURED";

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

export type CheckExternalAvailabilityResult = {
  ok: boolean;
  provider: BookingProviderResultSource;
  error?: CreateExternalBookingError;
  busy: Array<{ start: string; end: string }>;
  suggestedStarts?: string[];
};

export interface BookingProviderAdapter {
  readonly provider: BookingProvider;

  checkAvailability?(
    input: CheckExternalAvailabilityInput
  ): Promise<CheckExternalAvailabilityResult>;

  createExternalBooking(
    input: CreateExternalBookingInput
  ): Promise<CreateExternalBookingResult>;
}