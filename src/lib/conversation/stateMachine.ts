// backend/src/lib/conversation/stateMachine.ts

import type { Canal } from '../../lib/detectarIntencion';
import type { TurnContext } from "./turnContext";

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

export type Gate = (ctx: TurnContext) => Promise<GateResult>;

/**
 * Evento de entrada (un turno del usuario)
 */
export type TurnEvent = {
  tenantId: string;
  canal: Canal;
  contacto: string;

  userInput: string;
  idiomaDestino: "es" | "en";

  messageId: string | null;
};

/**
 * Resultado de la state machine
 */
export type StateResult =
  | { type: "continue" }
  | { type: "silence"; reason: string }
  | {
      type: "reply";
      text?: string;            // si ya viene armado
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
  // Guards (decision-only)
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
  return async function run(ctx: TurnContext): Promise<GateResult> {
    for (const gate of gates) {
      const r = await gate(ctx);
      if (r.action !== "continue") return r;
    }
    return { action: "continue" };
  };
}