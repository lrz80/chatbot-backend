// src/lib/voice/booking/services/square/squareServiceChoiceState.ts

import type { CallState } from "../../../types";

import type { SquareBookableService } from "../../../../integrations/square/getSquareBookableServices";

export type PendingSquareServiceChoice = {
  provider: "square";

  input: string;

  inputs: string[];

  /**
   * Última pregunta que Aamy hizo para distinguir
   * entre las opciones pendientes.
   *
   * No contiene lógica de negocio ni interpretación.
   */
  clarificationPrompt: string;

  options: SquareBookableService[];
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function isValidSquareServiceOption(
  option: SquareBookableService
): boolean {
  return Boolean(
    clean(option.itemId) &&
      clean(option.variationId) &&
      clean(option.itemName)
  );
}

function normalizeInputHistory(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => clean(item))
    .filter(Boolean);
}

function appendInputHistory(
  existingInputs: string[],
  newInput: unknown
): string[] {
  const input = clean(newInput);

  if (!input) {
    return [...existingInputs];
  }

  return [...existingInputs, input];
}

export function getPendingSquareServiceChoice(
  state: CallState
): PendingSquareServiceChoice | null {
  const pendingChoice =
    (state as any)?.pendingSquareServiceChoice;

  if (
    !pendingChoice ||
    pendingChoice.provider !== "square"
  ) {
    return null;
  }

  if (!Array.isArray(pendingChoice.options)) {
    return null;
  }

  const options = pendingChoice.options.filter(
    isValidSquareServiceOption
  );

  if (options.length === 0) {
    return null;
  }

  let inputs = normalizeInputHistory(
    pendingChoice.inputs
  );

  const legacyInput = clean(pendingChoice.input);

  if (inputs.length === 0 && legacyInput) {
    inputs = [legacyInput];
  }

  const input =
    inputs.length > 0
      ? inputs[inputs.length - 1]
      : legacyInput;

  return {
    provider: "square",
    input,
    inputs,
    clarificationPrompt: clean(
      pendingChoice.clarificationPrompt
    ),
    options,
  };
}

export function setPendingSquareServiceChoice(params: {
  state: CallState;
  input: string;
  options: SquareBookableService[];
  clarificationPrompt?: string;
}): CallState {
  const options = params.options.filter(
    isValidSquareServiceOption
  );

  const previous =
    getPendingSquareServiceChoice(params.state);

  const previousInputs =
    previous?.inputs ?? [];

  const inputs = appendInputHistory(
    previousInputs,
    params.input
  );

  const input =
    inputs.length > 0
      ? inputs[inputs.length - 1]
      : clean(params.input);

  return {
    ...(params.state as any),

    pendingSquareServiceChoice: {
      provider: "square",
      input,
      inputs,
      clarificationPrompt: clean(
        params.clarificationPrompt
      ),
      options,
    },
  } as CallState;
}

export function clearPendingSquareServiceChoice(
  state: CallState
): CallState {
  const nextState = {
    ...(state as any),
  };

  delete (nextState as any)
    .pendingSquareServiceChoice;

  return nextState as CallState;
}