// src/lib/voice/realtime/bookingStep/routeRealtimeBookingStep.ts
import {
  clean,
  isConfirmationLikeStep,
  type BookingFlowStepLike,
} from "../realtimeBookingFlowUtils";
import type { CallState } from "../../types";

export type RealtimeBookingStepRoute =
  | {
      kind: "service";
      rawSlot: string;
    }
  | {
      kind: "datetime";
      rawSlot: string;
    }
  | {
      kind: "post_booking_sms_consent";
      rawSlot: string;
    }
  | {
      kind: "post_booking_generic";
      rawSlot: string;
    }
  | {
      kind: "final_confirmation_before_create";
      rawSlot: string;
    }
  | {
      kind: "generic";
      rawSlot: string;
    };

function getRawSlot(step: BookingFlowStepLike): string {
  return typeof step.validation_config?.slot === "string"
    ? clean(step.validation_config.slot)
    : "";
}

function isAppointmentAlreadyCreated(state: CallState): boolean {
  return (
    Boolean(clean(state.bookingData?.appointment_id)) ||
    Boolean(clean(state.bookingData?.external_calendar_event_id)) ||
    Boolean(clean(state.bookingData?.google_event_id)) ||
    Boolean(clean(state.bookingData?.google_event_link))
  );
}

export function routeRealtimeBookingStep(params: {
  currentStep: BookingFlowStepLike;
  workingState: CallState;
}): RealtimeBookingStepRoute {
  const { currentStep, workingState } = params;

  const rawSlot = getRawSlot(currentStep);
  const stepKey = clean(currentStep.step_key);
  const expectedType = clean(currentStep.expected_type);

  const isServiceStep = stepKey === "service" || rawSlot === "service";
  const isDatetimeStep = stepKey === "datetime" || rawSlot === "datetime";

  if (isServiceStep) {
    return {
      kind: "service",
      rawSlot,
    };
  }

  if (isDatetimeStep) {
    return {
      kind: "datetime",
      rawSlot,
    };
  }

  const appointmentAlreadyCreated = isAppointmentAlreadyCreated(workingState);

  const isPostBookingStep =
    appointmentAlreadyCreated && expectedType === "confirmation";

  if (isPostBookingStep && stepKey === "offer_booking_sms") {
    return {
      kind: "post_booking_sms_consent",
      rawSlot,
    };
  }

  if (isPostBookingStep) {
    return {
      kind: "post_booking_generic",
      rawSlot,
    };
  }

  const isFinalConfirmationBeforeCreate =
    !appointmentAlreadyCreated && isConfirmationLikeStep(currentStep);

  if (isFinalConfirmationBeforeCreate) {
    return {
      kind: "final_confirmation_before_create",
      rawSlot,
    };
  }

  return {
    kind: "generic",
    rawSlot,
  };
}