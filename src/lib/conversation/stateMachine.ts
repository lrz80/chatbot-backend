// backend/src/lib/conversation/stateMachine.ts

import type { TurnContext } from "./turnContext";

// Tu evento del SM es el contexto completo del turno (pool, promptBase, helpers, etc.)
export type TurnEvent = TurnContext;

export type GateResult =
  | { action: "continue"; intent?: string; transition?: any }
  | { action: "silence"; reason: string; intent?: string; transition?: any }
  | {
      action: "reply";
      reply?: string;                 // reply directo
      replySource?: string;           // opcional
      facts?: Record<string, any>;    // decision-only
      intent?: string;
      transition?: any;
    };

// Gate SIEMPRE recibe TurnEvent (no TurnContext “aparte”)
export type Gate = (event: TurnEvent) => Promise<GateResult>;

/**
 * Resultado de la state machine
 */
export type StateResult =
  | { type: "continue" }
  | { type: "silence"; reason: string }
  | {
      type: "reply";
      text?: string;               // si ya viene armado
      facts?: Record<string, any>; // si hay que generar respuesta con prompt
      intent?: string | null;
      source?: string;
      transition?: StateTransition;
    }
  | {
      type: "transition";
      transition: StateTransition;
    };

/**
 * Cambio de estado (flow / step / ctx)
 */
export type StateTransition = {
  flow?: string;
  step?: string;
  patchCtx?: Record<string, any>;

  // Side-effects declarativos (los ejecuta el webhook)
  effects?: {
    awaiting?: {
      clear?: boolean;
      field?: string | null;
      value?: any;
      payload?: any;
    };
  };
};

export type StateMachineDeps = {
  paymentHumanGuard: (event: TurnEvent) => Promise<
    | { action: "continue" }
    | { action: "silence"; reason: string }
    | { action: "reply"; facts: any; intent?: string }
  >;

  yesNoStateGate: (event: TurnEvent) => Promise<
    | { action: "continue" }
    | { action: "silence"; reason: string }
    | {
        action: "reply";
        facts: any;
        intent?: string;
        transition?: StateTransition;
      }
  >;

  awaitingGate?: (event: TurnEvent) => Promise<
    | { action: "continue" }
    | {
        action: "reply";
        facts: any;
        intent?: string;
        transition?: StateTransition;
      }
  >;
};

export function createStateMachine(gates: Gate[]) {
  return async function run(event: TurnEvent): Promise<GateResult> {
    for (const gate of gates) {
      const r = await gate(event);
      if (r.action !== "continue") return r;
    }
    return { action: "continue" };
  };
}
