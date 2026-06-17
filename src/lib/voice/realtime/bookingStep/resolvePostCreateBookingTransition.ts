// src/lib/voice/realtime/bookingStep/resolvePostCreateBookingTransition.ts
import {
  clean,
  getStepIndexByKey,
  type BookingFlowStepLike,
} from "../realtimeBookingFlowUtils";

export type PostCreateBookingTransition = {
  informationalStepIndex: number | null;
  actionableStepIndex: number | null;
};

function isEnabledStep(step: BookingFlowStepLike | null | undefined): boolean {
  return Boolean(step && step.enabled !== false);
}

function getStepSlot(step: BookingFlowStepLike): string {
  const rawSlot =
    step.validation_config &&
    typeof step.validation_config === "object" &&
    typeof step.validation_config.slot === "string"
      ? step.validation_config.slot
      : "";

  return clean(rawSlot);
}

function getExpectedType(step: BookingFlowStepLike): string {
  return clean(step.expected_type).toLowerCase();
}

function getStepKey(step: BookingFlowStepLike): string {
  return clean(step.step_key);
}

function isInformationalPostCreateStep(step: BookingFlowStepLike): boolean {
  const slot = getStepSlot(step);
  const expectedType = getExpectedType(step);

  return (
    step.required !== true &&
    (slot === "" || slot === "none") &&
    expectedType !== "confirmation"
  );
}

function isActionablePostCreateStep(step: BookingFlowStepLike): boolean {
  const stepKey = getStepKey(step);
  const slot = getStepSlot(step);
  const expectedType = getExpectedType(step);

  /**
   * Explicit post-booking SMS consent step.
   *
   * This step is optional, but still actionable because the caller must answer
   * yes/no before the server may call send_booking_sms or skip_booking_sms.
   */

  if (step.required === true) return true;
  if (expectedType === "confirmation") return true;
  if (slot && slot !== "none") return true;

  return false;
}

export function resolvePostCreateBookingTransition(params: {
  steps: BookingFlowStepLike[];
  confirmationStepKey: string;
}): PostCreateBookingTransition {
  const confirmationKey = clean(params.confirmationStepKey);

  const confirmationIndex = getStepIndexByKey(params.steps, confirmationKey);

  console.log("[VOICE_REALTIME][POST_CREATE_TRANSITION_SCAN]", {
    confirmationStepKey: confirmationKey,
    confirmationIndex,
    steps: params.steps.map((step, index) => ({
      index,
      step_key: getStepKey(step),
      enabled: step.enabled !== false,
      required: step.required === true,
      expected_type: getExpectedType(step),
      slot: getStepSlot(step),
    })),
  });

  if (confirmationIndex < 0) {
    return {
      informationalStepIndex: null,
      actionableStepIndex: null,
    };
  }

  let informationalStepIndex: number | null = null;

  for (
    let index = confirmationIndex + 1;
    index < params.steps.length;
    index += 1
  ) {
    const step = params.steps[index];

    if (!isEnabledStep(step)) continue;

    if (informationalStepIndex === null && isInformationalPostCreateStep(step)) {
      informationalStepIndex = index;
      continue;
    }

    if (isActionablePostCreateStep(step)) {
      console.log("[VOICE_REALTIME][POST_CREATE_TRANSITION_SELECTED]", {
        informationalStepIndex,
        actionableStepIndex: index,
        actionableStepKey: getStepKey(step),
      });

      return {
        informationalStepIndex,
        actionableStepIndex: index,
      };
    }
  }

  console.log("[VOICE_REALTIME][POST_CREATE_TRANSITION_NONE]", {
    informationalStepIndex,
    actionableStepIndex: null,
  });

  return {
    informationalStepIndex,
    actionableStepIndex: null,
  };
}