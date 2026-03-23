import type { Pool } from "pg";
import type { FastpathResult } from "../../runFastpath";

export type HandleFollowupRouterInput = {
  pool: Pool;
  tenantId: string;
  userInput: string;
  convoCtx: any;
  isFreshCatalogPriceTurn: boolean;

  bestNameMatch: (
    userText: string,
    items: Array<{ id?: string; name: string; url?: string | null }>
  ) => any;

  resolveServiceIdFromText: (
    pool: Pool,
    tenantId: string,
    text: string,
    opts?: any
  ) => Promise<any>;
};

export async function handleFollowupRouter(
  input: HandleFollowupRouterInput
): Promise<FastpathResult> {
  if (input.isFreshCatalogPriceTurn) {
    return {
      handled: false,
    };
  }

  const t = String(input.userInput || "").trim();
  const tLower = t.toLowerCase();

  const isShort =
    t.length > 0 &&
    t.length <= 22 &&
    !t.includes("?") &&
    !/\b(hola|hi|hello|gracias|thanks)\b/i.test(tLower);

  const now = Date.now();
  const ttlMs = 10 * 60 * 1000;

  const fresh = (at: any) => {
    const n = Number(at || 0);
    return Number.isFinite(n) && n > 0 && now - n <= ttlMs;
  };

  const pendingPrice =
    Boolean((input.convoCtx as any)?.pending_price_lookup) &&
    fresh((input.convoCtx as any)?.pending_price_at);

  const pendingLink =
    Boolean((input.convoCtx as any)?.pending_link_lookup) &&
    fresh((input.convoCtx as any)?.pending_link_at);

  const lastServiceId = String(
    (input.convoCtx as any)?.last_service_id || ""
  ).trim();

  const lastServiceFresh =
    lastServiceId && fresh((input.convoCtx as any)?.last_service_at);

  const planList = Array.isArray((input.convoCtx as any)?.last_plan_list)
    ? (input.convoCtx as any).last_plan_list
    : [];

  const pkgList = Array.isArray((input.convoCtx as any)?.last_package_list)
    ? (input.convoCtx as any).last_package_list
    : [];

  const listFresh =
    (planList.length && fresh((input.convoCtx as any)?.last_plan_list_at)) ||
    (pkgList.length && fresh((input.convoCtx as any)?.last_package_list_at));

  if (
    isShort &&
    pendingLink &&
    Array.isArray((input.convoCtx as any)?.pending_link_options)
  ) {
    const opts = (input.convoCtx as any).pending_link_options;

    const pick = input.bestNameMatch(
      t,
      opts.map((o: any) => ({ name: o.label })) as any
    );

    if (pick?.name) {
      return {
        handled: false,
        ctxPatch: {
          pending_link_lookup: null,
          pending_link_at: null,
          pending_link_options: null,
          last_bot_action: "followup_link_pick",
          last_bot_action_at: now,
        } as any,
      };
    }
  }

  if (isShort && listFresh) {
    return {
      handled: false,
    };
  }

  if (isShort && pendingPrice) {
    const pendingTargetText = String(
      (input.convoCtx as any)?.pending_price_target_text || ""
    ).trim();

    const textForResolution = pendingTargetText || t;

    const hit = await input.resolveServiceIdFromText(
      input.pool,
      input.tenantId,
      textForResolution,
      {
        mode: "loose",
      }
    );

    if (hit?.id) {
      return {
        handled: false,
        ctxPatch: {
          last_service_id: hit.id,
          last_service_name: hit.name,
          last_service_at: now,
          pending_price_lookup: null,
          pending_price_at: null,
          pending_price_target_text: null,
          pending_price_raw_user_text: null,
          last_bot_action: "followup_set_service_for_price",
          last_bot_action_at: now,
        } as any,
      };
    }
  }

  const hasExplicitVariantSelectionContext =
    Boolean(input.convoCtx?.expectingVariant) &&
    Boolean(input.convoCtx?.selectedServiceId);

  if (isShort && lastServiceFresh && !hasExplicitVariantSelectionContext) {
    return {
      handled: false,
      ctxPatch: {
        last_price_option_label: t,
        last_price_option_at: now,
        last_bot_action: "followup_option_label",
        last_bot_action_at: now,
      } as any,
    };
  }

  return {
    handled: false,
  };
}