//src/lib/channels/engine/domain/executeDomainRouterTurn.ts

import type { Pool } from "pg";
import type { Canal, CommercialSignal } from "../../../detectarIntencion";
import type { LangCode } from "../../../i18n/lang";
import { executeBusinessInfoTurn } from "../businessInfo/executeBusinessInfoTurn";
import { executeExternalActionContinuation } from "../businessInfo/executeExternalActionContinuation";
import { executeCatalogTurn } from "../catalog/executeCatalogTurn";

type IntentFacets = {
  asksPrices?: boolean;
  asksSchedules?: boolean;
  asksLocation?: boolean;
  asksAvailability?: boolean;
};

type DomainRouteTarget = "catalog" | "business_info" | "continue_pipeline";

function normalizeDomainRouteTarget(
  value: unknown
): DomainRouteTarget {
  const routeTarget = String(value || "").trim();

  if (
    routeTarget === "catalog" ||
    routeTarget === "business_info" ||
    routeTarget === "continue_pipeline"
  ) {
    return routeTarget;
  }

  return "continue_pipeline";
}

type ExecuteDomainRouterTurnArgs = {
  pool: Pool;
  tenant: any;
  canal: Canal;
  idiomaDestino: LangCode;
  userInput: string;
  contactoNorm: string;
  messageId: string | null;
  promptBaseMem: string;
  infoClave: string;

  inBooking: boolean;
  convoCtx: any;
  ctxPatch?: any;

  routeTarget?: unknown;
  shouldUseGuidedEntryOutsideFastpath: boolean;

  detectedIntent: string | null;
  detectedFacets?: IntentFacets | null;
  detectedCommercial?: CommercialSignal | null;
  routingHints?: any;

  catalogReferenceClassification?: any;
  canonicalCatalogResolution?: {
    resolutionKind: string;
    resolvedServiceId?: string | null;
    resolvedServiceName?: string | null;
    variantOptions?: Array<{
      variantId: string;
      variantName: string;
    }>;
  };

  maxLines?: number;
};

type ExecuteDomainRouterTurnResult = {
  handled: boolean;
  reply?: string;
  source?: string;
  intent?: string | null;
  ctxPatch?: any;
  reason?: string;
};

function isAmbiguousCatalogFamilyTurn(input: {
  catalogReferenceClassification?: any;
  canonicalCatalogResolution?: any;
}): boolean {
  const catalogReferenceClassification = input.catalogReferenceClassification;
  const canonicalCatalogResolution = input.canonicalCatalogResolution;

  return Boolean(
    canonicalCatalogResolution?.resolutionKind === "ambiguous" &&
      (
        catalogReferenceClassification?.kind === "catalog_family" ||
        catalogReferenceClassification?.targetLevel === "family" ||
        catalogReferenceClassification?.targetLevel === "multi_service" ||
        catalogReferenceClassification?.routeIntent === "catalog_family"
      )
  );
}

async function tryExecuteCatalog(
  args: ExecuteDomainRouterTurnArgs
): Promise<ExecuteDomainRouterTurnResult> {
  const catalogResult = await executeCatalogTurn({
    pool: args.pool,
    tenantId: args.tenant.id,
    canal: args.canal,
    idiomaDestino: args.idiomaDestino,
    userInput: args.userInput,
    contactoNorm: args.contactoNorm,
    messageId: args.messageId,
    promptBaseMem: args.promptBaseMem,
    infoClave: args.infoClave,
    inBooking: args.inBooking,
    convoCtx: args.convoCtx,
    ctxPatch: args.ctxPatch || {},
    detectedIntent: args.detectedIntent,
    detectedFacets: args.detectedFacets || null,
    detectedCommercial: args.detectedCommercial || null,
    catalogReferenceClassification: args.catalogReferenceClassification,
    canonicalCatalogResolution: args.canonicalCatalogResolution,
    maxDisambiguationOptions: 10,
    maxLines: args.maxLines,
  });

  if (catalogResult.handled && catalogResult.reply) {
    return {
      handled: true,
      reply: catalogResult.reply,
      source: catalogResult.source || "catalog_route",
      intent: catalogResult.intent || args.detectedIntent || null,
      ctxPatch: catalogResult.ctxPatch || {},
      reason: "catalog_handled",
    };
  }

  if (
    isAmbiguousCatalogFamilyTurn({
      catalogReferenceClassification: args.catalogReferenceClassification,
      canonicalCatalogResolution: args.canonicalCatalogResolution,
    })
  ) {
    return {
      handled: false,
      source: catalogResult.source || "catalog_deferred",
      intent: catalogResult.intent || args.detectedIntent || null,
      ctxPatch: catalogResult.ctxPatch || {},
      reason: "ambiguous_catalog_family_deferred",
    };
  }

  return {
    handled: false,
    source: catalogResult.source || "catalog_not_handled",
    intent: catalogResult.intent || args.detectedIntent || null,
    ctxPatch: catalogResult.ctxPatch || {},
    reason: "catalog_not_handled",
  };
}

async function tryExecuteExternalActionContinuation(
  args: ExecuteDomainRouterTurnArgs
): Promise<ExecuteDomainRouterTurnResult> {
  const externalActionResult = await executeExternalActionContinuation({
    tenantId: args.tenant.id,
    canal: args.canal,
    idiomaDestino: args.idiomaDestino,
    userInput: args.userInput,
    contactoNorm: args.contactoNorm,
    messageId: args.messageId,
    promptBaseMem: args.promptBaseMem,
    convoCtx: args.convoCtx,
    detectedIntent: args.detectedIntent,
    detectedFacets: args.detectedFacets || null,
    detectedCommercial: args.detectedCommercial || null,
    maxLines: args.maxLines,
  });

  if (!externalActionResult.handled || !externalActionResult.reply) {
    return {
      handled: false,
      source: externalActionResult.source || "external_action_not_handled",
      intent: externalActionResult.intent || args.detectedIntent || null,
      ctxPatch: externalActionResult.ctxPatch || {},
      reason: "external_action_not_handled",
    };
  }

  return {
    handled: true,
    reply: externalActionResult.reply,
    source: externalActionResult.source || "external_action_link",
    intent: externalActionResult.intent || "external_action",
    ctxPatch: externalActionResult.ctxPatch || {},
    reason: "external_action_handled",
  };
}

async function tryExecuteBusinessInfo(
  args: ExecuteDomainRouterTurnArgs
): Promise<ExecuteDomainRouterTurnResult> {
  const businessInfoResult = await executeBusinessInfoTurn({
    pool: args.pool,
    tenant: args.tenant,
    canal: args.canal,
    idiomaDestino: args.idiomaDestino,
    userInput: args.userInput,
    contactoNorm: args.contactoNorm,
    messageId: args.messageId,
    promptBaseMem: args.promptBaseMem,
    infoClave: args.infoClave,
    convoCtx: args.convoCtx,
    detectedIntent: args.detectedIntent,
    intentFallback: args.detectedIntent,
    detectedFacets: args.detectedFacets || null,
    detectedCommercial: args.detectedCommercial || null,
    routingHints: args.routingHints || null,
    overviewMode: args.shouldUseGuidedEntryOutsideFastpath
      ? "guided_entry"
      : "general_overview",
    maxLines: args.maxLines,
  });

  if (!businessInfoResult.handled || !businessInfoResult.reply) {
    return {
      handled: false,
      source: businessInfoResult.source || "business_info_not_handled",
      intent: businessInfoResult.intent || args.detectedIntent || null,
      ctxPatch: businessInfoResult.ctxPatch || {},
      reason: "business_info_not_handled",
    };
  }

  return {
    handled: true,
    reply: businessInfoResult.reply,
    source: businessInfoResult.source || "business_info",
    intent: businessInfoResult.intent || args.detectedIntent || null,
    ctxPatch: businessInfoResult.ctxPatch || {},
    reason: "business_info_handled",
  };
}

export async function executeDomainRouterTurn(
  args: ExecuteDomainRouterTurnArgs
): Promise<ExecuteDomainRouterTurnResult> {
  const routeTarget = normalizeDomainRouteTarget(args.routeTarget);

  if (routeTarget === "catalog") {
    return await tryExecuteCatalog(args);
  }

  if (
    routeTarget === "business_info" ||
    args.shouldUseGuidedEntryOutsideFastpath
  ) {
    const externalActionResult =
      await tryExecuteExternalActionContinuation(args);

    if (externalActionResult.handled) {
      return externalActionResult;
    }

    return await tryExecuteBusinessInfo(args);
  }

  return {
    handled: false,
    source: "continue_pipeline",
    intent: args.detectedIntent || null,
    ctxPatch: {},
    reason: "continue_pipeline_no_auto_compose",
  };
}