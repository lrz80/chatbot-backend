// backend/src/lib/channels/engine/sm/handleStateMachineTurn.ts

import { Pool } from "pg";
import type { Lang } from "../clients/clientDb";
import type { Canal } from "../../../detectarIntencion";

import { applyAwaitingEffects } from "../state/applyAwaitingEffects";
import {
  upsertSelectedChannelDB,
  upsertIdiomaClienteDB,
  type SelectedChannel,
} from "../clients/clientDb";
import { parseDatosCliente } from "../../../../lib/parseDatosCliente";

type StateMachineFn = (args: any) => Promise<any>;

type TransitionLike = {
  flow?: string;
  step?: string;
  patchCtx?: Record<string, any>;
  effects?: {
    awaiting?: {
      clear?: boolean;
      field?: string | null;
      value?: any;
      payload?: any;
    };
  };
};

export type HandleStateMachineTurnResult =
  | {
      handled: false;
      replied: false;
      activatedBooking: boolean;
      activatedEstimate: boolean;
      intent?: string | null;
      replySource?: string | null;
      facts?: any;
      transition?: TransitionLike | null;
    }
  | {
      handled: true;
      replied: boolean;
      activatedBooking: boolean;
      activatedEstimate: boolean;
      intent?: string | null;
      replySource?: string | null;
      facts?: any;
      transition?: TransitionLike | null;
    };

export type HandleStateMachineTurnArgs = {
  pool: Pool;
  sm: StateMachineFn;

  tenant: any;
  canal: Canal;
  contactoNorm: string;
  userInput: string;
  messageId: string | null;
  idiomaDestino: Lang;

  promptBase: string;

  tenantId: string;

  replyAndExit: (
    text: string,
    source: string,
    intent?: string | null
  ) => Promise<void>;

  applyTransitionAndPersist: (transition: TransitionLike) => Promise<void>;

  parseDatosCliente: typeof parseDatosCliente;
  extractPaymentLinkFromPrompt?: ((text: string) => string | null) | null;
  PAGO_CONFIRM_REGEX?: RegExp | null;
};

function getActivatedFlags(transition?: TransitionLike | null): {
  activatedBooking: boolean;
  activatedEstimate: boolean;
} {
  const patchCtx = transition?.patchCtx || {};

  const activatedBooking = Boolean(
    patchCtx?.booking?.active === true &&
      patchCtx?.booking?.step &&
      patchCtx.booking.step !== "idle"
  );

  const activatedEstimate = Boolean(
    patchCtx?.estimateFlow?.active === true &&
      patchCtx?.estimateFlow?.step &&
      patchCtx.estimateFlow.step !== "idle"
  );

  return {
    activatedBooking,
    activatedEstimate,
  };
}

export async function handleStateMachineTurn(
  args: HandleStateMachineTurnArgs
): Promise<HandleStateMachineTurnResult> {
  const {
    pool,
    sm,
    canal,
    contactoNorm,
    userInput,
    messageId,
    idiomaDestino,
    promptBase,
    tenantId,
    replyAndExit,
    applyTransitionAndPersist,
    parseDatosCliente,
    extractPaymentLinkFromPrompt = null,
    PAGO_CONFIRM_REGEX = null,
  } = args;

  const smResult = await sm({
    pool,
    tenantId,
    canal,
    contacto: contactoNorm,
    senderId: contactoNorm,
    userInput,
    messageId,
    idiomaDestino,
    promptBase,
    parseDatosCliente,
    extractPaymentLinkFromPrompt:
      extractPaymentLinkFromPrompt || ((_: string) => null),
    PAGO_CONFIRM_REGEX,
  } as any);

  if (!smResult || smResult.action === "continue") {
    return {
      handled: false,
      replied: false,
      activatedBooking: false,
      activatedEstimate: false,
    };
  }

  if (smResult.action === "silence") {
    console.log("🧱 [SM] silence:", smResult.reason);
    return {
      handled: true,
      replied: false,
      activatedBooking: false,
      activatedEstimate: false,
    };
  }

  if (smResult.transition?.effects) {
    await applyAwaitingEffects({
      pool,
      tenantId,
      canal,
      contacto: contactoNorm,
      effects: smResult.transition.effects,
      upsertSelectedChannelDB: (
        tenantId: string,
        canal: string,
        contacto: string,
        selected: SelectedChannel
      ) =>
        upsertSelectedChannelDB(pool, tenantId, canal, contacto, selected),
      upsertIdiomaClienteDB: (
        tenantId: string,
        canal: string,
        contacto: string,
        idioma: Lang
      ) => upsertIdiomaClienteDB(pool, tenantId, canal, contacto, idioma),
    });
  }

  if (smResult.action === "transition") {
    await applyTransitionAndPersist(smResult.transition || {});

    const { activatedBooking, activatedEstimate } = getActivatedFlags(
      smResult.transition || {}
    );

    return {
      handled: true,
      replied: false,
      activatedBooking,
      activatedEstimate,
      intent: smResult.intent || null,
      replySource: smResult.replySource || null,
      facts: smResult.facts ?? null,
      transition: smResult.transition || null,
    };
  }

  if (smResult.action === "reply") {
    if (smResult.transition) {
      await applyTransitionAndPersist(smResult.transition);
    }

    const { activatedBooking, activatedEstimate } = getActivatedFlags(
      smResult.transition || {}
    );

    const directReply = String(smResult.reply || "").trim();

    if (directReply) {
      await replyAndExit(
        directReply,
        smResult.replySource || "state_machine",
        smResult.intent || null
      );

      return {
        handled: true,
        replied: true,
        activatedBooking,
        activatedEstimate,
        intent: smResult.intent || null,
        replySource: smResult.replySource || "state_machine",
        facts: smResult.facts ?? null,
        transition: smResult.transition || null,
      };
    }

    console.log("[SM][REPLY_WITHOUT_TEXT]", {
      tenantId,
      canal,
      contactoNorm,
      intent: smResult.intent || null,
      replySource: smResult.replySource || null,
      hasFacts: Boolean(smResult.facts),
    });

    return {
      handled: false,
      replied: false,
      activatedBooking,
      activatedEstimate,
      intent: smResult.intent || null,
      replySource: smResult.replySource || null,
      facts: smResult.facts ?? null,
      transition: smResult.transition || null,
    };
  }

  return {
    handled: false,
    replied: false,
    activatedBooking: false,
    activatedEstimate: false,
  };
}