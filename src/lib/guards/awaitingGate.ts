// backend/src/lib/guards/awaitingGate.ts

import { getAwaitingState, validateAwaitingInput } from "../awaiting";
import type { TurnEvent, StateTransition } from "../conversation/stateMachine";

export type AwaitingGateResult =
  | { action: "continue" }
  | {
      action: "reply";
      facts: any;
      intent?: string;
      transition?: StateTransition;
    };

export async function awaitingGate(event: TurnEvent): Promise<AwaitingGateResult> {
  const { tenantId, canal, senderId, userInput } = event;

  const row = await getAwaitingState(tenantId, canal, senderId);
  if (!row?.awaiting_field) return { action: "continue" };

  const awaitingField = String(row.awaiting_field);
  const awaitingPayload = row.awaiting_payload ?? {};

  const check = validateAwaitingInput({
    awaitingField,
    userText: userInput,
    awaitingPayload,
  });

  // Si el usuario "escapó" hacia pregunta general, NO consumimos awaiting
  if (!check.ok) {
    if (check.reason === "escape") return { action: "continue" };

    // no_match: seguimos esperando, devolvemos respuesta guiada (facts)
    return {
      action: "reply",
      intent: "awaiting_no_match",
      facts: {
        kind: "awaiting_no_match",
        awaitingField,
        awaitingPayload,
      },
    };
  }

  // ok: consumimos el awaiting (pero el webhook ejecuta el clear)
  const transition: StateTransition = {
    effects: {
      awaiting: {
        clear: true,
        field: awaitingField,
        value: check.value,
        payload: awaitingPayload,
      },
    },
  };

  return {
    action: "reply",
    intent: "awaiting_ok",
    facts: {
      kind: "awaiting_ok",
      awaitingField,
      value: check.value,
    },
    transition,
  };
}
