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

function isInformationalPostCreateStep(step: BookingFlowStepLike): boolean {
  const slot = getStepSlot(step);
  const expectedType = getExpectedType(step);

  return step.required !== true && (slot === "" || slot === "none") && expectedType !== "confirmation";
}

function isActionablePostCreateStep(step: BookingFlowStepLike): boolean {
  const slot = getStepSlot(step);
  const expectedType = getExpectedType(step);

  if (step.required === true) return true;
  if (expectedType === "confirmation") return true;
  if (slot && slot !== "none") return true;

  return false;
}

export function resolvePostCreateBookingTransition(params: {
  steps: BookingFlowStepLike[];
  confirmationStepKey: string;
}): PostCreateBookingTransition {
  const confirmationIndex = getStepIndexByKey(
    params.steps,
    clean(params.confirmationStepKey)
  );

  if (confirmationIndex < 0) {
    return {
      informationalStepIndex: null,
      actionableStepIndex: null,
    };
  }

  let informationalStepIndex: number | null = null;

  for (let index = confirmationIndex + 1; index < params.steps.length; index += 1) {
    const step = params.steps[index];

    if (!isEnabledStep(step)) continue;

    if (informationalStepIndex === null && isInformationalPostCreateStep(step)) {
      informationalStepIndex = index;
      continue;
    }

    if (isActionablePostCreateStep(step)) {
      return {
        informationalStepIndex,
        actionableStepIndex: index,
      };
    }
  }

  return {
    informationalStepIndex,
    actionableStepIndex: null,
  };
}