// src/lib/voice/realtime/bookingStep/validateFieldServiceAddressStep.ts

import type {
  CallState,
  VoiceLocale,
} from "../../types";

import type {
  BookingFlowStepLike,
  BookingState,
} from "../realtimeBookingFlowUtils";

import {
  getAppointmentSettings,
} from "../../../appointments/getAppointmentSettings";

import {
  geocodeFieldServiceBaseAddress,
  validateFieldServiceArea,
} from "../../../../modules/field-operations/services/fieldServiceArea.service";

type ValidateFieldServiceAddressStepParams = {
  tenantId: string;
  callSid: string;
  currentLocale: VoiceLocale;

  currentStep: BookingFlowStepLike;
  currentIndex: number;
  stepKey: string;
  targetSlot: string;
  resolvedInputValue: string;

  state: CallState;
  steps: BookingFlowStepLike[];

  buildRealtimeBookingState: (params: {
    steps: BookingFlowStepLike[];
    state: CallState;
    explicitCurrentIndex?: number | null;
    finalConfirmationGranted?: boolean;
    readyToCreate?: boolean;
  }) => BookingState;

  persistVoiceState: (params: {
    tenantId: string;
    callSid: string;
    state: CallState;
    locale: VoiceLocale;
  }) => Promise<void>;
};

export type ValidateFieldServiceAddressStepResult =
  | {
      handled: false;
      normalizedValue: string;
    }
  | {
      handled: true;
      result: any;
      cancelledState?: CallState;
    };

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeKey(value: unknown): string {
  return clean(value).toLowerCase();
}

function isFieldServiceAddressStep(params: {
  currentStep: BookingFlowStepLike;
  stepKey: string;
  targetSlot: string;
}): boolean {
  const validationConfig =
    params.currentStep.validation_config &&
    typeof params.currentStep.validation_config === "object"
      ? params.currentStep.validation_config
      : {};

  const configuredRole = normalizeKey(
    (validationConfig as any).field_service_role
  );

  if (configuredRole === "service_address") {
    return true;
  }

  const canonicalSlot =
    normalizeKey(params.targetSlot) ||
    normalizeKey(
      (params.currentStep as any).slot
    );

  const canonicalStepKey =
    normalizeKey(params.stepKey);

  return (
    canonicalSlot === "address" ||
    canonicalSlot === "service_address" ||
    canonicalSlot === "property_address" ||
    canonicalStepKey === "address" ||
    canonicalStepKey === "service_address" ||
    canonicalStepKey === "property_address"
  );
}

function buildCancelledBookingState(
  state: CallState
): CallState {
  return {
    ...state,

    bookingStepIndex: undefined,

    pendingBookingStepKey: undefined,
    pendingBookingStepPrompt: undefined,
    pendingBookingStepRequired: undefined,
    pendingBookingStepSlot: undefined,
    pendingBookingStepExpectedType: undefined,
    pendingBookingStepValidationConfig: undefined,

    pendingBookingStepPromptAnchorTranscript:
      undefined,

    pendingBookingStepPromptAnchorSeq:
      undefined,

    pendingBookingStepAwaitingFreshUserInput:
      undefined,

    pendingBookingStepRequiresFreshInputAfterPrompt:
      undefined,

    pendingActionGranted:
      undefined,

    pendingActionAnswered:
      undefined,

    pendingActionToolName:
      undefined,

    bookingTurnStatus:
      "idle",

    bookingData:
      {},
  } as CallState;
}

export async function validateFieldServiceAddressStep(
  params: ValidateFieldServiceAddressStepParams
): Promise<ValidateFieldServiceAddressStepResult> {
  const isAddressStep =
    isFieldServiceAddressStep({
      currentStep:
        params.currentStep,
      stepKey:
        params.stepKey,
      targetSlot:
        params.targetSlot,
    });

  if (!isAddressStep) {
    return {
      handled: false,
      normalizedValue:
        params.resolvedInputValue,
    };
  }

  const settings =
    await getAppointmentSettings(
      params.tenantId
    );

  if (
    settings.field_service_area_enabled !==
    true
  ) {
    return {
      handled: false,
      normalizedValue:
        params.resolvedInputValue,
    };
  }

  const submittedAddress =
    clean(params.resolvedInputValue);

  if (!submittedAddress) {
    const bookingState =
      params.buildRealtimeBookingState({
        steps:
          params.steps,

        state:
          params.state,

        explicitCurrentIndex:
          params.currentIndex,
      });

    return {
      handled: true,

      result: {
        ok: false,

        error:
          "FIELD_SERVICE_ADDRESS_REQUIRED",

        booking_outcome:
          "requires_customer_action",

        customer_action_required:
          true,

        instructions:
          JSON.stringify({
            event:
              "FIELD_SERVICE_ADDRESS_REQUIRED",

            response_behavior: {
              request_service_address:
                true,

              use_active_conversation_language:
                true,

              do_not_continue_booking:
                true,

              do_not_mention_internal_error:
                true,
            },
          }),

        booking_state:
          bookingState,

        next_required_step:
          null,
      },
    };
  }

  const geocodedAddress =
    await geocodeFieldServiceBaseAddress({
      address:
        submittedAddress,
    });

  const hasStreetNumber =
    geocodedAddress.addressComponents.some(
      (component) =>
        component.types.includes(
          "street_number"
        )
    );

  const hasRoute =
    geocodedAddress.addressComponents.some(
      (component) =>
        component.types.includes(
          "route"
        )
    );

  const isPreciseLocation =
    geocodedAddress.locationType ===
      "ROOFTOP" ||
    geocodedAddress.locationType ===
      "RANGE_INTERPOLATED";

  const hasReliableAddressMatch =
    geocodedAddress.partialMatch !== true &&
    hasStreetNumber &&
    hasRoute &&
    isPreciseLocation;

  if (!hasReliableAddressMatch) {
    const bookingState =
      params.buildRealtimeBookingState({
        steps:
          params.steps,

        state:
          params.state,

        explicitCurrentIndex:
          params.currentIndex,
      });

    console.warn(
      "[VOICE_REALTIME][FIELD_SERVICE_ADDRESS_AMBIGUOUS]",
      {
        callSid:
          params.callSid,

        tenantId:
          params.tenantId,

        submittedAddress,

        formattedAddress:
          geocodedAddress.formattedAddress,

        partialMatch:
          geocodedAddress.partialMatch,

        locationType:
          geocodedAddress.locationType,

        hasStreetNumber,
        hasRoute,
      }
    );

    return {
      handled: true,

      result: {
        ok: false,

        error:
          "FIELD_SERVICE_ADDRESS_AMBIGUOUS",

        booking_outcome:
          "requires_customer_action",

        customer_action_required:
          true,

        instructions:
          JSON.stringify({
            event:
              "FIELD_SERVICE_ADDRESS_AMBIGUOUS",

            response_behavior: {
              request_service_address_again:
                true,

              explain_address_could_not_be_verified:
                true,

              use_active_conversation_language:
                true,

              do_not_continue_booking:
                true,

              do_not_mention_internal_error:
                true,
            },
          }),

        booking_state:
          bookingState,

        next_required_step:
          null,
      },
    };
  }

  const areaValidation =
    await validateFieldServiceArea({
      tenantId:
        params.tenantId,

      latitude:
        geocodedAddress.latitude,

      longitude:
        geocodedAddress.longitude,
    });

  console.log(
    "[VOICE_REALTIME][FIELD_SERVICE_ADDRESS_VALIDATED]",
    {
      callSid:
        params.callSid,

      tenantId:
        params.tenantId,

      formattedAddress:
        geocodedAddress.formattedAddress,

      allowed:
        areaValidation.allowed,

      reason:
        areaValidation.reason,

      distanceMiles:
        areaValidation.distanceMiles,

      radiusMiles:
        areaValidation.radiusMiles,
    }
  );

  if (areaValidation.allowed) {
    return {
      handled: false,

      normalizedValue:
        geocodedAddress.formattedAddress,
    };
  }

  const cancelledState =
    buildCancelledBookingState(
      params.state
    );

  await params.persistVoiceState({
    tenantId:
      params.tenantId,

    callSid:
      params.callSid,

    state:
      cancelledState,

    locale:
      params.currentLocale,
  });

  console.warn(
    "[VOICE_REALTIME][BOOKING_CANCELLED_OUTSIDE_SERVICE_AREA]",
    {
      callSid:
        params.callSid,

      tenantId:
        params.tenantId,

      reason:
        areaValidation.reason,

      formattedAddress:
        geocodedAddress.formattedAddress,

      distanceMiles:
        areaValidation.distanceMiles,

      radiusMiles:
        areaValidation.radiusMiles,
    }
  );

  return {
    handled: true,

    cancelledState,

    result: {
      ok: false,

      error:
        areaValidation.reason ||
        "FIELD_SERVICE_LOCATION_NOT_ALLOWED",

      booking_outcome:
        "cancelled_outside_service_area",

      customer_action_required:
        false,

      action_required:
        null,

      instructions:
        JSON.stringify({
          event:
            areaValidation.reason ||
            "FIELD_SERVICE_LOCATION_NOT_ALLOWED",

          conversation_transition: {
            cancel_booking_flow:
              true,

            return_to_general_conversation:
              true,
          },

          service_area: {
            formatted_address:
              geocodedAddress.formattedAddress,

            distance_miles:
              areaValidation.distanceMiles,

            radius_miles:
              areaValidation.radiusMiles,
          },

          response_behavior: {
            inform_customer_service_is_not_currently_available_in_that_area:
              true,

            apologize_briefly:
              true,

            ask_if_customer_needs_anything_else:
              true,

            use_active_conversation_language:
              true,

            do_not_request_another_address:
              true,

            do_not_continue_booking:
              true,

            do_not_mention_internal_error:
              true,

            do_not_mention_distance_unless_useful:
              true,
          },
        }),

      details: {
        reason:
          areaValidation.reason,

        formattedAddress:
          geocodedAddress.formattedAddress,

        distanceMiles:
          areaValidation.distanceMiles,

        radiusMiles:
          areaValidation.radiusMiles,
      },

      booking_state: {
        current_step_key:
          null,

        current_step_slot:
          null,

        awaiting_confirmation:
          false,

        final_confirmation_granted:
          false,

        ready_to_create:
          false,

        collected_slots:
          {},
      },

      next_required_step:
        null,
    },
  };
}