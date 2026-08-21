export type BookingProvider =
  | "google_calendar"
  | "square"
  | "glofox";

export type BookingProviderResultSource = BookingProvider | "system";

export type SquareBookingPayload = {
  locationId?: string | null;
  customerId?: string | null;
  teamMemberId?: string | null;
  serviceVariationId?: string | null;
  serviceVariationVersion?: number | string | null;
};

/**
 * Glofox supports different booking models.
 *
 * event:
 *   Group classes / scheduled events.
 *
 * timeslot:
 *   Appointments / one-to-one services.
 *
 * Do not use the deprecated "trainer" model for new integrations.
 */
export type GlofoxBookingModel = "event" | "timeslot";

export type GlofoxBookingPayload = {
  /**
   * Glofox Member/User ID.
   */
  userId?: string | null;

  /**
   * Booking resource type in Glofox.
   */
  model?: GlofoxBookingModel | null;

  /**
   * ID of the event or appointment timeslot being booked.
   */
  modelId?: string | null;

  /**
   * Optional payment method expected by Glofox.
   *
   * Keep this dynamic because available payment methods
   * can vary by Glofox configuration.
   */
  paymentMethod?: string | null;

  /**
   * true only when payment will be collected at the gym.
   */
  payGym?: boolean | null;

  /**
   * Number of additional guests attached to the booking.
   */
  guestBookings?: number | null;

  /**
   * Whether Glofox should process the charge.
   *
   * Do not default this to false globally.
   */
  charge?: boolean | null;

  /**
   * Used when the selected event is full and the member
   * explicitly agrees to join the waiting list.
   */
  joinWaitingList?: boolean | null;
};

export type CreateExternalBookingInput = {
  tenantId: string;
  summary: string;
  description?: string;
  startISO: string;
  endISO: string;
  timeZone: string;
  bufferMin: number;

  calendarId?: string | null;

  customer?: {
    name?: string | null;
    phone?: string | null;
    email?: string | null;
  };

  providerPayload?: {
    square?: SquareBookingPayload;
    glofox?: GlofoxBookingPayload;
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
  | "SQUARE_WRITE_OPERATIONS_NOT_SUPPORTED"
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