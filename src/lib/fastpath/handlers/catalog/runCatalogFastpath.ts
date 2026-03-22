import { Pool } from "pg";
import type { FastpathResult } from "../../runFastpath";
import { getCatalogStructuredSignals } from "./getCatalogStructuredSignals";
import { getCatalogTurnState } from "./getCatalogTurnState";
import { getCatalogRoutingState } from "./getCatalogRoutingState";
import { getCatalogIntentFlags } from "./getCatalogIntentFlags";

export type RunCatalogFastpathInput = {
  pool: Pool;
  tenantId: string;
  userInput: string;
  idiomaDestino: string;
  convoCtx: any;
  catalogReferenceClassification?: any;
  catalogRoutingSignal?: any;
  routeIntent?: string | null;

  intentOut?: string | null;
  detectedIntent?: string | null;
  infoClave?: string | null;

  buildCatalogRoutingSignal: (input: {
    intentOut: string | null;
    catalogReferenceClassification?: any;
    convoCtx: any;
  }) => any;

  buildCatalogContext: (pool: Pool, tenantId: string) => Promise<string>;
};

export type RunCatalogFastpathResult = FastpathResult;

export async function runCatalogFastpath(
  input: RunCatalogFastpathInput
): Promise<RunCatalogFastpathResult> {
  const {
    catalogRoutingSignal: derivedCatalogRoutingSignal,
    catalogRouteIntent,
  } = getCatalogRoutingState({
    detectedIntent: input.detectedIntent || input.intentOut || null,
    isStructuredCatalogTurn: true,
    catalogReferenceClassification: input.catalogReferenceClassification,
    convoCtx: input.convoCtx,
    buildCatalogRoutingSignal: input.buildCatalogRoutingSignal,
  });

  const catalogRoutingSignal =
    input.catalogRoutingSignal || derivedCatalogRoutingSignal;

  const routeIntent = String(
    input.routeIntent || catalogRouteIntent || catalogRoutingSignal?.routeIntent || ""
  ).trim();

  const {
    referenceKind,
    targetServiceId,
    targetVariantId,
    targetFamilyKey,
    hasStructuredTarget,
    shouldResolveFromStructuredTarget,
  } = getCatalogStructuredSignals({
    catalogReferenceClassification: input.catalogReferenceClassification,
    convoCtx: input.convoCtx,
  });

  const {
    isCombinationIntent,
    asksIncludesOnly,
    isAskingOtherCatalogOptions,
    asksSchedules,
  } = getCatalogIntentFlags({
    routeIntent,
  });

  const {
    hasRecentCatalogContext,
    intentAllowsCatalogRouting,
    isCatalogPriceLikeTurn,
    hasStructuredCatalogState,
    isCatalogQuestion,
  } = getCatalogTurnState({
    catalogRoutingSignal,
    convoCtx: input.convoCtx,
    hasStructuredTarget,
  });

  if (!isCatalogQuestion) {
    return {
      handled: false,
    };
  }

  console.log("[CATALOG_FASTPATH] entered", {
    tenantId: input.tenantId,
    userInput: input.userInput,
    routeIntent,
    referenceKind,
    hasStructuredTarget,
    shouldResolveFromStructuredTarget,
    targetServiceId,
    targetVariantId,
    targetFamilyKey,
  });

  // ⛔ aquí vamos a mover el motor grande en el próximo paso
  return {
    handled: false,
  };
}