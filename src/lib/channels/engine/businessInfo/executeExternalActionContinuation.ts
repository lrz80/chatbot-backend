//src/lib/channels/engine/businessInfo/executeExternalActionContinuation.ts

import type { Canal, CommercialSignal } from "../../../detectarIntencion";
import type { LangCode } from "../../../i18n/lang";
import { renderFastpathDmReply } from "../fastpath/renderFastpathDmReply";
import { buildStaticFastpathReplyPolicy } from "../fastpath/buildFastpathReplyPolicy";
import type {
  BusinessInfoExternalActionContext,
} from "./executeBusinessInfoTurn";
import type {
  BusinessInfoIntentFacets,
} from "./composeBusinessInfoAnswer";

type ExecuteExternalActionContinuationArgs = {
  tenantId: string;
  canal: Canal;
  idiomaDestino: LangCode;
  userInput: string;
  contactoNorm: string;
  messageId: string | null;
  promptBaseMem: string;
  convoCtx?: any;

  detectedIntent: string | null;
  detectedFacets?: BusinessInfoIntentFacets | null;
  detectedCommercial?: CommercialSignal | null;

  maxLines?: number;
};

type ExecuteExternalActionContinuationResult = {
  handled: boolean;
  reply?: string;
  source?: string;
  intent?: string | null;
  ctxPatch?: any;
};

function getExternalActionContext(
  convoCtx?: any
): BusinessInfoExternalActionContext | null {
  const actionContext = convoCtx?.actionContext ?? null;

  if (!actionContext || typeof actionContext !== "object") {
    return null;
  }

  if (actionContext.type !== "external_action") {
    return null;
  }

  if (actionContext.channel !== "link") {
    return null;
  }

  if (actionContext.dispatchPolicy !== "affirmative_continuation") {
    return null;
  }

  if (!String(actionContext.targetUrl || "").trim()) {
    return null;
  }

  return actionContext as BusinessInfoExternalActionContext;
}

function isNewBusinessInfoQuestion(
  facets?: BusinessInfoIntentFacets | null
): boolean {
  return Boolean(
    facets?.asksPrices ||
      facets?.asksSchedules ||
      facets?.asksLocation ||
      facets?.asksAvailability
  );
}

function isAffirmativeContinuationCandidate(input: {
  userInput: string;
  resolvedIntent: string | null;
}): boolean {
  const raw = String(input.userInput || "").trim();

  if (!raw) {
    return false;
  }

  const normalizedIntent = String(input.resolvedIntent || "")
    .trim()
    .toLowerCase();

  if (raw.includes("?") || raw.includes("¿")) {
    return false;
  }

  if (normalizedIntent && normalizedIntent !== "duda") {
    return false;
  }

  const tokenCount = raw.split(/\s+/).filter(Boolean).length;

  return tokenCount <= 3;
}

function buildExternalActionContextPatch(input: {
  userInput: string;
  reply: string;
}) {
  const createdAt = new Date().toISOString();

  const lastTurn = {
    domain: "business_info" as const,
    references: {
      serviceId: null,
      familyId: null,
      variantId: null,
    },
    intent: "external_action",
    userText: input.userInput,
    assistantText: input.reply,
    canonicalSource: "business_info" as const,
    createdAt,
  };

  return {
    actionContext: null,
    last_bot_action: "external_action_sent",

    continuationContext: {
      lastTurn,
    },
    last_assistant_turn: lastTurn,

    structuredService: null,
    pendingCatalogChoice: null,
    pendingCatalogChoiceAt: null,
    expectingVariant: false,
    expectingVariantForEntityId: null,
    expectedVariantIntent: null,
    presentedVariantOptions: null,
    last_variant_options: null,
    last_variant_options_at: null,
  };
}

export async function executeExternalActionContinuation(
  args: ExecuteExternalActionContinuationArgs
): Promise<ExecuteExternalActionContinuationResult> {
  const {
    tenantId,
    canal,
    idiomaDestino,
    userInput,
    contactoNorm,
    messageId,
    promptBaseMem,
    convoCtx,
    detectedIntent,
    detectedFacets,
    detectedCommercial,
    maxLines = 9999,
  } = args;

  const actionContext = getExternalActionContext(convoCtx);

  if (!actionContext) {
    return {
      handled: false,
      source: "external_action_missing_context",
    };
  }

  if (isNewBusinessInfoQuestion(detectedFacets)) {
    return {
      handled: false,
      source: "external_action_new_business_info_question",
    };
  }

  const resolvedIntent =
    String(detectedIntent || "").trim().toLowerCase() || null;

  if (
    !isAffirmativeContinuationCandidate({
      userInput,
      resolvedIntent,
    })
  ) {
    return {
      handled: false,
      source: "external_action_not_affirmative_continuation",
    };
  }

  const targetUrl = String(actionContext.targetUrl || "").trim();

  const rendered = await renderFastpathDmReply({
    tenantId,
    canal,
    idiomaDestino,
    userInput,
    contactoNorm,
    messageId,
    promptBaseMem,
    fastpathText: targetUrl,
    fp: {
      reply: targetUrl,
      source: "external_action_link",
      intent: "external_action",
      externalAction: {
        type: "link",
        targetUrl,
      },
      catalogPayload: undefined,
    },
    detectedIntent: "external_action",
    intentFallback: "external_action",
    structuredService: {
      serviceId: null,
      serviceName: null,
      serviceLabel: null,
      hasResolution: false,
    },
    replyPolicy: buildStaticFastpathReplyPolicy({
      canal,
      answerType: "action_link",
      replySourceKind: "business_info",
      responsePolicyMode: "grounded_frame_only",
      hasResolvedEntity: false,
      isCatalogDbReply: false,
      isPriceSummaryReply: false,
      isPriceDisambiguationReply: false,
      isGroundedCatalogReply: false,
      isGroundedCatalogOverviewDm: false,
      shouldForceSalesClosingQuestion: false,
      shouldUseGroundedFrameOnly: true,
      canonicalBodyOwnsClosing: false,
      clarificationTarget: null,
      commercialPolicy: {
        purchaseIntent: detectedCommercial?.purchaseIntent ?? "low",
        wantsBooking: detectedCommercial?.wantsBooking === true,
        wantsQuote: detectedCommercial?.wantsQuote === true,
        wantsHuman: detectedCommercial?.wantsHuman === true,
        urgency: detectedCommercial?.urgency ?? "low",
        shouldUseSalesTone: true,
        shouldUseSoftClosing: true,
        shouldUseDirectClosing: false,
        shouldSuggestHumanHandoff: detectedCommercial?.wantsHuman === true,
      },
    }),
    ctxPatch: {},
    maxLines,
  });

  const reply = String(rendered.reply || "").trim();

  if (!reply) {
    return {
      handled: false,
      source: "external_action_render_empty",
      intent: "external_action",
    };
  }

  return {
    handled: true,
    reply,
    source: "external_action_link",
    intent: "external_action",
    ctxPatch: {
      ...(rendered.ctxPatch || {}),
      ...buildExternalActionContextPatch({
        userInput,
        reply,
      }),
    },
  };
}