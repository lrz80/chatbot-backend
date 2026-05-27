// src/lib/voice/booking/services/square/squareServiceChoiceState.ts

import type { CallState } from "../../../types";
import type { SquareBookableService } from "../../../../integrations/square/getSquareBookableServices";

export type PendingSquareServiceChoice = {
  provider: "square";
  input: string;
  options: SquareBookableService[];
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function isValidSquareServiceOption(option: SquareBookableService): boolean {
  return Boolean(
    clean(option.itemId) &&
      clean(option.variationId) &&
      clean(option.itemName)
  );
}

export function getPendingSquareServiceChoice(
  state: CallState
): PendingSquareServiceChoice | null {
  const pendingChoice = (state as any)?.pendingSquareServiceChoice;

  if (!pendingChoice || pendingChoice.provider !== "square") {
    return null;
  }

  if (!Array.isArray(pendingChoice.options)) {
    return null;
  }

  const options = pendingChoice.options.filter(isValidSquareServiceOption);

  if (options.length === 0) {
    return null;
  }

  return {
    provider: "square",
    input: clean(pendingChoice.input),
    options,
  };
}

export function setPendingSquareServiceChoice(params: {
  state: CallState;
  input: string;
  options: SquareBookableService[];
}): CallState {
  const options = params.options.filter(isValidSquareServiceOption);

  return {
    ...(params.state as any),
    pendingSquareServiceChoice: {
      provider: "square",
      input: clean(params.input),
      options,
    },
  } as CallState;
}

export function clearPendingSquareServiceChoice(state: CallState): CallState {
  const nextState = {
    ...(state as any),
  };

  delete (nextState as any).pendingSquareServiceChoice;

  return nextState as CallState;
}