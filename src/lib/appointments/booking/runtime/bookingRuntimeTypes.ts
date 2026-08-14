// src/lib/appointments/booking/runtime/bookingRuntimeTypes.ts

export type BookingChannel =
  | "voice"
  | "whatsapp"
  | "instagram"
  | "facebook";

export type BookingRuntimeLocale = string;

export type BookingRuntimeState = {
  bookingData?: Record<string, string>;
  bookingStepIndex?: number;

  pendingBookingStepKey?: string;
  pendingBookingStepSlot?: string;
  pendingBookingStepExpectedType?: string;

  bookingFlowLoaded?: boolean;

  [key: string]: unknown;
};

export type BookingRuntimeMappedStep = {
  step_key: string;
  step_order: number;
  slot: string;
  prompt: string;
  expected_type: string;
  required: boolean;
  retry_prompt: string;
  validation_config: Record<string, unknown> | null;
  prompt_translations: Record<string, unknown> | null;
  retry_prompt_translations: Record<string, unknown> | null;
};