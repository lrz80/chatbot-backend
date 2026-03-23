import type { FastpathCtx } from "../../runFastpath";
import type { Lang } from "../../../channels/engine/clients/clientDb";

type HandleFastpathDismissInput = {
  q: string;
  idiomaDestino: Lang;
  convoCtx: Partial<FastpathCtx> | null | undefined;
  intentOut?: string | null;
};

type HandleFastpathDismissResult =
  | { handled: false }
  | {
      handled: true;
      reply: string;
      source: "fastpath_dismiss";
      intent: string;
      ctxPatch: Partial<FastpathCtx>;
    };

function hasActiveFastpathContext(convoCtx: Partial<FastpathCtx> | null | undefined): boolean {
  return (
    (Array.isArray(convoCtx?.last_plan_list) && convoCtx!.last_plan_list.length > 0) ||
    (Array.isArray(convoCtx?.last_package_list) && convoCtx!.last_package_list.length > 0) ||
    !!convoCtx?.last_service_id ||
    !!convoCtx?.pending_price_lookup ||
    !!convoCtx?.pending_link_lookup
  );
}

function isDismissMessage(q: string, hasFastpathContext: boolean): boolean {
  const explicitNoThanks =
    /\b(no gracias|no, gracias|no por ahora|no quiero|no necesito|estoy bien|todo bien)\b/i.test(q) ||
    /\b(no thanks|no, thanks|i'm good|im good|all good|not now)\b/i.test(q);

  const plainThanks = /\b(gracias|thanks)\b/i.test(q);

  return explicitNoThanks || (plainThanks && hasFastpathContext);
}

function buildDismissCtxPatch(now: number): Partial<FastpathCtx> {
  return {
    last_plan_list: undefined,
    last_plan_list_at: undefined,
    last_package_list: undefined,
    last_package_list_at: undefined,
    last_list_kind: undefined,
    last_list_kind_at: undefined,

    last_service_id: null,
    last_service_name: null,
    last_service_at: null,

    pending_price_lookup: undefined,
    pending_price_at: undefined,

    pending_link_lookup: undefined,
    pending_link_at: undefined,
    pending_link_options: undefined,

    last_price_option_label: undefined,
    last_price_option_at: undefined,

    last_selected_kind: null,
    last_selected_id: null,
    last_selected_name: null,
    last_selected_at: null,

    last_catalog_plans: undefined,
    last_catalog_at: undefined,

    last_bot_action: "fastpath_dismiss",
    last_bot_action_at: now,
  };
}

function buildDismissReply(idiomaDestino: Lang): string {
  return idiomaDestino === "en"
    ? "Perfect, if you need anything else just let me know 😊"
    : "Perfecto 😊 si necesitas algo más, aquí estoy para ayudarte.";
}

export function handleFastpathDismiss(
  input: HandleFastpathDismissInput
): HandleFastpathDismissResult {
  const { q, idiomaDestino, convoCtx, intentOut } = input;

  const hasFastpathContext = hasActiveFastpathContext(convoCtx);
  const dismiss = isDismissMessage(q, hasFastpathContext);

  if (!dismiss) {
    return { handled: false };
  }

  const now = Date.now();

  return {
    handled: true,
    reply: buildDismissReply(idiomaDestino),
    source: "fastpath_dismiss",
    intent: intentOut || "fastpath_dismiss",
    ctxPatch: buildDismissCtxPatch(now),
  };
}