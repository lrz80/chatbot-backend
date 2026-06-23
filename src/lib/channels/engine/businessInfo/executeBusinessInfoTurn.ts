//src/lib/channels/engine/businessInfo/executeBusinessInfoTurn.ts

import type { Pool } from "pg";
import type {
  Canal,
  CommercialSignal,
  IntentRoutingHints,
} from "../../../detectarIntencion";
import type { LangCode } from "../../../i18n/lang";
import { normalizeCatalogRole } from "../../../catalog/normalizeCatalogRole";
import { traducirMensaje } from "../../../traducirMensaje";
import { renderGenericPriceSummaryReply } from "../../../services/pricing/renderGenericPriceSummaryReply";
import {
  composeBusinessInfoAnswer,
  type BusinessInfoIntentFacets,
} from "./composeBusinessInfoAnswer";
import { resolveBusinessInfoOverviewCanonicalBody } from "./resolveBusinessInfoOverviewCanonicalBody";
import { renderFastpathDmReply } from "../fastpath/renderFastpathDmReply";
import { buildStaticFastpathReplyPolicy } from "../fastpath/buildFastpathReplyPolicy";

export type BusinessInfoOverviewMode = "general_overview" | "guided_entry";

export type BusinessInfoExternalActionContext = {
  type: "external_action";
  channel: "link";
  dispatchPolicy: "affirmative_continuation";
  targetUrl: string;
  sourceDomain: "business_info" | "catalog" | "booking" | "other";
  createdAt: string;
};

export type ExecuteBusinessInfoTurnArgs = {
  pool: Pool;
  tenant: any;
  canal: Canal;
  idiomaDestino: LangCode;
  userInput: string;
  contactoNorm: string;
  messageId: string | null;
  promptBaseMem: string;
  infoClave: string;
  convoCtx?: any;

  detectedIntent: string | null;
  intentFallback: string | null;
  detectedFacets?: BusinessInfoIntentFacets | null;
  detectedCommercial?: CommercialSignal | null;
  routingHints?: IntentRoutingHints | null;

  overviewMode?: BusinessInfoOverviewMode;
  maxLines?: number;
};

export type ExecuteBusinessInfoTurnResult = {
  handled: boolean;
  reply?: string;
  source?: string;
  intent?: string | null;
  ctxPatch?: any;
};

function resolveBusinessInfoIntent(args: {
  routeIntent: string;
  wantsBusinessFacets: boolean;
  asksPrices: boolean;
  asksSchedules: boolean;
  asksLocation: boolean;
  asksAvailability: boolean;
}): string {
  if (!args.wantsBusinessFacets) {
    return args.routeIntent;
  }

  if (args.asksPrices && args.asksSchedules) {
    return "precio_y_horario";
  }

  if (args.asksPrices) {
    return "precio";
  }

  if (args.asksSchedules && !args.asksLocation && !args.asksAvailability) {
    return "horario";
  }

  if (args.asksLocation && !args.asksSchedules && !args.asksAvailability) {
    return "ubicacion";
  }

  if (args.asksAvailability && !args.asksSchedules && !args.asksLocation) {
    return "disponibilidad";
  }

  return "info_general";
}

function resolveContinuationBusinessInfoIntent(convoCtx?: any): string {
  const lastTurn = convoCtx?.continuationContext?.lastTurn ?? null;

  if (!lastTurn || lastTurn.domain !== "business_info") {
    return "";
  }

  return String(lastTurn.intent || "").trim().toLowerCase();
}

function shouldAllowBusinessInfoIntentInheritance(input: {
  routingHints?: IntentRoutingHints | null;
}): boolean {
  const catalogScope = String(input.routingHints?.catalogScope || "none")
    .trim()
    .toLowerCase();

  const businessInfoScope = String(input.routingHints?.businessInfoScope || "none")
    .trim()
    .toLowerCase();

  return catalogScope === "none" && businessInfoScope !== "none";
}

function resolveEffectiveFacets(input: {
  detectedFacets?: BusinessInfoIntentFacets | null;
  convoCtx?: any;
  routingHints?: IntentRoutingHints | null;
}): Required<BusinessInfoIntentFacets> {
  const explicitAsksPrices = input.detectedFacets?.asksPrices === true;
  const explicitAsksSchedules = input.detectedFacets?.asksSchedules === true;
  const explicitAsksLocation = input.detectedFacets?.asksLocation === true;
  const explicitAsksAvailability = input.detectedFacets?.asksAvailability === true;

  const hasExplicitFacet =
    explicitAsksPrices ||
    explicitAsksSchedules ||
    explicitAsksLocation ||
    explicitAsksAvailability;

  const continuedBusinessInfoIntent = resolveContinuationBusinessInfoIntent(
    input.convoCtx
  );

  const allowInheritance =
    !hasExplicitFacet &&
    shouldAllowBusinessInfoIntentInheritance({
      routingHints: input.routingHints || null,
    });

  return {
    asksPrices: explicitAsksPrices,
    asksSchedules:
      explicitAsksSchedules ||
      (
        allowInheritance &&
        continuedBusinessInfoIntent === "horario"
      ),
    asksLocation:
      explicitAsksLocation ||
      (
        allowInheritance &&
        continuedBusinessInfoIntent === "ubicacion"
      ),
    asksAvailability:
      explicitAsksAvailability ||
      (
        allowInheritance &&
        continuedBusinessInfoIntent === "disponibilidad"
      ),
  };
}

function selectBusinessInfoExternalAction(input: {
  tenant: any;
  resolvedBusinessIntent: string;
  overviewMode: BusinessInfoOverviewMode;
  wantsBusinessFacets: boolean;
  asksSchedules: boolean;
  asksLocation: boolean;
  asksAvailability: boolean;
}): BusinessInfoExternalActionContext | null {
  if (input.overviewMode === "guided_entry") {
    return null;
  }

  if (!input.wantsBusinessFacets) {
    return null;
  }

  if (input.asksLocation || input.asksAvailability) {
    return null;
  }

  const canAttachBookingUrl =
    input.asksSchedules &&
    (
      input.resolvedBusinessIntent === "horario" ||
      input.resolvedBusinessIntent === "precio_y_horario"
    );

  if (!canAttachBookingUrl) {
    return null;
  }

  const targetUrl = String(
    input.tenant?.booking_url ||
      input.tenant?.bookingUrl ||
      input.tenant?.settings?.booking?.booking_url ||
      ""
  ).trim();

  if (!targetUrl) {
    return null;
  }

  return {
    type: "external_action",
    channel: "link",
    dispatchPolicy: "affirmative_continuation",
    targetUrl,
    sourceDomain: "business_info",
    createdAt: new Date().toISOString(),
  };
}

function buildBusinessInfoContextPatch(input: {
  userInput: string;
  reply: string;
  intent: string | null;
  actionContext?: BusinessInfoExternalActionContext | null;
}) {
  const createdAt = new Date().toISOString();

  const lastTurn = {
    domain: "business_info" as const,
    references: {
      serviceId: null,
      familyId: null,
      variantId: null,
    },
    intent: input.intent || null,
    userText: input.userInput,
    assistantText: input.reply,
    canonicalSource: "business_info" as const,
    createdAt,
  };

  return {
    continuationContext: {
      lastTurn,
    },
    last_assistant_turn: lastTurn,
    actionContext: input.actionContext ?? null,

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

export async function executeBusinessInfoTurn(
  args: ExecuteBusinessInfoTurnArgs
): Promise<ExecuteBusinessInfoTurnResult> {
  const {
    pool,
    tenant,
    canal,
    idiomaDestino,
    userInput,
    contactoNorm,
    messageId,
    promptBaseMem,
    infoClave,
    convoCtx,
    detectedIntent,
    intentFallback,
    detectedFacets,
    detectedCommercial,
    routingHints,
    overviewMode = "general_overview",
    maxLines = 9999,
  } = args;

  const tenantId = String(tenant?.id || "").trim();

  if (!tenantId) {
    return { handled: false, source: "business_info_missing_tenant" };
  }

  const routeIntent =
    String(detectedIntent || intentFallback || "").trim() || "info_general";

  const effectiveFacets = resolveEffectiveFacets({
    detectedFacets,
    convoCtx,
    routingHints: routingHints || null,
  });

  const wantsBusinessFacets =
    effectiveFacets.asksPrices ||
    effectiveFacets.asksSchedules ||
    effectiveFacets.asksLocation ||
    effectiveFacets.asksAvailability;

  const resolvedBusinessIntent = resolveBusinessInfoIntent({
    routeIntent,
    wantsBusinessFacets,
    asksPrices: effectiveFacets.asksPrices,
    asksSchedules: effectiveFacets.asksSchedules,
    asksLocation: effectiveFacets.asksLocation,
    asksAvailability: effectiveFacets.asksAvailability,
  });

  const actionContext = selectBusinessInfoExternalAction({
    tenant,
    resolvedBusinessIntent,
    overviewMode,
    wantsBusinessFacets,
    asksSchedules: effectiveFacets.asksSchedules,
    asksLocation: effectiveFacets.asksLocation,
    asksAvailability: effectiveFacets.asksAvailability,
  });

  if (wantsBusinessFacets) {
    const composed = await composeBusinessInfoAnswer({
      pool,
      tenantId,
      canal,
      idiomaDestino,
      userInput,
      contactoNorm,
      messageId,
      promptBaseMem,
      infoClave,
      convoCtx: convoCtx || {},
      detectedIntent: resolvedBusinessIntent,
      intentFallback: routeIntent,
      detectedFacets: effectiveFacets,
      detectedCommercial: detectedCommercial || null,
      routingHints: routingHints || null,
      externalAction: actionContext
        ? {
            type: "link",
            targetUrl: actionContext.targetUrl,
          }
        : null,
      normalizeCatalogRole,
      traducirTexto: traducirMensaje,
      renderGenericPriceSummaryReply,
      maxLines,
    });

    if (!composed.handled || !composed.reply) {
      return {
        handled: false,
        source: composed.source || "business_info_empty",
        intent: composed.intent || resolvedBusinessIntent,
      };
    }

    const ctxPatch = buildBusinessInfoContextPatch({
      userInput,
      reply: composed.reply,
      intent: composed.intent || resolvedBusinessIntent,
      actionContext,
    });

    return {
      handled: true,
      reply: composed.reply,
      source: composed.source || "business_info",
      intent: composed.intent || resolvedBusinessIntent,
      ctxPatch: {
        ...(composed.ctxPatch || {}),
        ...ctxPatch,
      },
    };
  }

  const canonicalBody = await resolveBusinessInfoOverviewCanonicalBody({
    tenantId,
    canal,
    idiomaDestino,
    userInput,
    promptBaseMem,
    infoClave,
    convoCtx: convoCtx || {},
    overviewMode,
  });

  const normalizedCanonicalBody = String(canonicalBody || "").trim();

  if (!normalizedCanonicalBody) {
    return {
      handled: false,
      source: "business_info_overview_empty",
      intent: resolvedBusinessIntent,
    };
  }

  const rendered = await renderFastpathDmReply({
    tenantId,
    canal,
    idiomaDestino,
    userInput,
    contactoNorm,
    messageId,
    promptBaseMem,
    fastpathText: normalizedCanonicalBody,
    fp: {
      reply: normalizedCanonicalBody,
      source:
        overviewMode === "guided_entry"
          ? "info_general_guided_entry_db"
          : "info_general_overview_db",
      intent: resolvedBusinessIntent,
      catalogPayload: undefined,
    },
    detectedIntent: resolvedBusinessIntent,
    intentFallback: resolvedBusinessIntent,
    structuredService: {
      serviceId: null,
      serviceName: null,
      serviceLabel: null,
      hasResolution: false,
    },
    replyPolicy: buildStaticFastpathReplyPolicy({
      canal,
      answerType: "overview",
      replySourceKind: "business_info",
      responsePolicyMode: "grounded_frame_only",
      hasResolvedEntity: false,
      isCatalogDbReply: false,
      isPriceSummaryReply: false,
      isPriceDisambiguationReply: false,
      isGroundedCatalogReply: false,
      isGroundedCatalogOverviewDm: true,
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
      source: "business_info_render_empty",
      intent: resolvedBusinessIntent,
    };
  }

  const ctxPatch = buildBusinessInfoContextPatch({
    userInput,
    reply,
    intent: resolvedBusinessIntent,
    actionContext: null,
  });

  return {
    handled: true,
    reply,
    source:
      overviewMode === "guided_entry"
        ? "info_general_guided_entry_db"
        : "info_general_overview_db",
    intent: resolvedBusinessIntent,
    ctxPatch: {
      ...(rendered.ctxPatch || {}),
      ...ctxPatch,
    },
  };
}