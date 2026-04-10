//src/lib/fastpath/runCatalogDomainTurn.ts
import type { Pool } from "pg";

import type { Canal } from "../detectarIntencion";
import type { Lang } from "../channels/engine/clients/clientDb";
import { traducirMensaje } from "../traducirMensaje";
import { traducirTexto } from "../traducirTexto";
import { normalizeText } from "../infoclave/resolveIncludes";
import { getServiceDetailsText } from "../services/resolveServiceInfo";
import {
  resolveServiceCandidatesFromText,
  resolveServiceIdFromText,
} from "../services/pricing/resolveServiceIdFromText";
import { resolveBestLinkForService } from "../links/resolveBestLinkForService";
import { getServiceAndVariantUrl } from "../services/getServiceAndVariantUrl";
import { renderGenericPriceSummaryReply } from "../services/pricing/renderGenericPriceSummaryReply";
import { extractQueryFrames } from "./extractQueryFrames";
import { resolveServiceMatchesFromText } from "../services/pricing/resolveServiceMatchesFromText";
import type { CatalogReferenceClassification } from "../catalog/types";
import { buildCatalogRoutingSignal } from "../catalog/buildCatalogRoutingSignal";
import { runCatalogFastpath } from "./handlers/catalog/runCatalogFastpath";
import { handleCatalogComparison } from "./handlers/catalog/handleCatalogComparison";
import { getCatalogStructuredSignals } from "./handlers/catalog/getCatalogStructuredSignals";
import { getCatalogDetailSignals } from "./handlers/catalog/getCatalogDetailSignals";
import { getCatalogRoutingState } from "./handlers/catalog/getCatalogRoutingState";
import { handleVariantSecondTurn } from "./handlers/catalog/handleVariantSecondTurn";
import { handleLastVariantIncludes } from "./handlers/catalog/handleLastVariantIncludes";
import { handleResolvedServiceDetail } from "./handlers/catalog/handleResolvedServiceDetail";
import { handleVariantFollowupSameService } from "./handlers/catalog/handleVariantFollowupSameService";
import { handleFollowupRouter } from "./handlers/catalog/handleFollowupRouter";
import { handlePickFromLastList } from "./handlers/catalog/handlePickFromLastList";
import { handleMultiQuestionSplitAnswer } from "./handlers/catalog/handleMultiQuestionSplitAnswer";
import { handleFastpathDismiss } from "./handlers/catalog/handleFastpathDismiss";
import { handlePendingLinkSelection } from "./handlers/catalog/handlePendingLinkSelection";
import { handlePendingLinkGuardrail } from "./handlers/catalog/handlePendingLinkGuardrail";
import { handleFreeOffer } from "./handlers/catalog/handleFreeOffer";
import { handleInterestToLink } from "./handlers/catalog/handleInterestToLink";
import { resolveFirstTurnServiceDetailTarget } from "./handlers/catalog/resolveFirstTurnServiceDetailTarget";
import { handleFirstTurnVariantDetail } from "./handlers/catalog/handleFirstTurnVariantDetail";
import {
  bestNameMatch,
  extractPlanNamesFromReply,
} from "./helpers/catalogTextMatching";
import { normalizeCatalogRole } from "../catalog/normalizeCatalogRole";
import type { FastpathCtx, FastpathResult } from "./runFastpath";

type IntentFacets = {
  asksPrices?: boolean;
  asksSchedules?: boolean;
  asksLocation?: boolean;
  asksAvailability?: boolean;
};

export type RunCatalogDomainTurnArgs = {
  pool: Pool;
  tenantId: string;
  canal: Canal;
  idiomaDestino: Lang;
  userInput: string;
  inBooking: boolean;
  convoCtx: FastpathCtx;
  infoClave: string;
  detectedIntent?: string | null;
  detectedFacets?: IntentFacets | null;
  catalogReferenceClassification?: CatalogReferenceClassification;
  maxDisambiguationOptions?: number;
  catalogRouteContext?: {
    canonicalCatalogResolution?: {
      resolutionKind: string;
      resolvedServiceId?: string | null;
      resolvedServiceName?: string | null;
      variantOptions?: Array<{
      variantId: string;
      variantName: string;
      }>;
    };
  };
};

export async function runCatalogDomainTurn(
  args: RunCatalogDomainTurnArgs
): Promise<FastpathResult> {
  const {
    pool,
    tenantId,
    canal,
    idiomaDestino,
    userInput,
    inBooking,
    convoCtx: initialConvoCtx,
    infoClave,
    detectedIntent,
    detectedFacets,
    catalogReferenceClassification,
    maxDisambiguationOptions = 5,
  } = args;

  void canal;
  void infoClave;

  let convoCtx = initialConvoCtx;

  const hasPendingCatalogChoice =
    Boolean(convoCtx?.pendingCatalogChoice) &&
    (
      convoCtx?.pendingCatalogChoice?.kind === "service_choice" ||
      convoCtx?.pendingCatalogChoice?.kind === "variant_choice"
    );

  const q = userInput.toLowerCase().trim();

  if (inBooking) {
    return { handled: false };
  }

  const intentOut = (detectedIntent || "").trim() || null;

  const catalogReferenceKind =
    catalogReferenceClassification?.kind ?? "none";

  const hasConcreteTargetThisTurn =
    Boolean(catalogReferenceClassification?.targetServiceId) ||
    Boolean(catalogReferenceClassification?.targetVariantId) ||
    Boolean(catalogReferenceClassification?.targetFamilyKey);

  const hasAnyCatalogFacet =
    detectedFacets?.asksPrices === true ||
    detectedFacets?.asksSchedules === true ||
    detectedFacets?.asksLocation === true ||
    detectedFacets?.asksAvailability === true;

  const isGenericDiscoveryIntent =
    (intentOut === "info_general" || intentOut === "duda") &&
    !hasAnyCatalogFacet &&
    !hasConcreteTargetThisTurn;

  const shouldBypassCatalogFollowupReuse =
    isGenericDiscoveryIntent && !hasPendingCatalogChoice;

  const isCatalogOverviewTurn =
    catalogReferenceKind === "catalog_overview";

  const isCatalogFamilyTurn =
    catalogReferenceKind === "catalog_family";

  const isEntitySpecificTurn =
    catalogReferenceKind === "entity_specific";

  const isVariantSpecificTurn =
    catalogReferenceKind === "variant_specific";

  const isReferentialFollowupTurn =
    catalogReferenceKind === "referential_followup";

  const isStructuredCatalogTurn =
    catalogReferenceKind === "catalog_overview" ||
    catalogReferenceKind === "catalog_family" ||
    catalogReferenceKind === "entity_specific" ||
    catalogReferenceKind === "variant_specific" ||
    catalogReferenceKind === "referential_followup" ||
    catalogReferenceKind === "comparison";

  void isCatalogOverviewTurn;
  void isCatalogFamilyTurn;
  void isEntitySpecificTurn;
  void isVariantSpecificTurn;
  void isReferentialFollowupTurn;

  const { isFreshCatalogPriceTurn } = getCatalogRoutingState({
    detectedIntent,
    isStructuredCatalogTurn,
    catalogReferenceClassification,
    convoCtx,
    buildCatalogRoutingSignal,
  });

  {
    const multiQuestionResult = await handleMultiQuestionSplitAnswer({
      userInput,
      idiomaDestino,
      tenantId,
      pool,
      intentOut,
      extractQueryFrames,
      normalizeText,
      resolveServiceMatchesFromText,
      resolveServiceIdFromText,
      bestNameMatch,
    });

    if (multiQuestionResult.handled) {
      return multiQuestionResult as any;
    }
  }

  {
    const fastpathDismissResult = handleFastpathDismiss({
      q,
      idiomaDestino,
      convoCtx,
      intentOut,
    });

    if (fastpathDismissResult.handled) {
      return fastpathDismissResult;
    }
  }

  {
    if (catalogReferenceClassification?.kind === "comparison") {
      const comparisonResult = await handleCatalogComparison({
        pool,
        tenantId,
        userInput,
        idiomaDestino,
        catalogReferenceClassification,
      });

      if (comparisonResult.handled) {
        return comparisonResult;
      }
    }
  }

  if (!hasPendingCatalogChoice) {
    const pendingLinkSelectionResult = await handlePendingLinkSelection({
      userInput,
      idiomaDestino,
      convoCtx,
      pool,
      normalizeText,
      bestNameMatch,
      intentOut,
    });

    if (pendingLinkSelectionResult.handled) {
      return pendingLinkSelectionResult;
    }
  }

  if (!hasPendingCatalogChoice) {
    const pickFromLastListResult = await handlePickFromLastList({
      userInput,
      idiomaDestino,
      convoCtx,
      tenantId,
      pool,
      detectedIntent,
      catalogReferenceClassification,
      intentOut,
      normalizeText,
      bestNameMatch,
      getServiceDetailsText,
      resolveBestLinkForService,
    });

    if (pickFromLastListResult.handled) {
      return pickFromLastListResult as any;
    }
  }

  {
    const pendingLinkGuardrailResult = handlePendingLinkGuardrail({
      userInput,
      convoCtx,
      isFreshCatalogPriceTurn,
    });

    if (pendingLinkGuardrailResult.handled) {
      convoCtx = {
        ...(convoCtx || {}),
        ...(pendingLinkGuardrailResult.ctxPatch || {}),
      };
    }
  }

  {
    const freeOfferResult = await handleFreeOffer({
      pool,
      tenantId,
      idiomaDestino,
      detectedIntent,
      catalogReferenceClassification,
      convoCtx,
    });

    if (freeOfferResult.handled) {
      return freeOfferResult;
    }
  }

  {
    const interestToLinkResult = await handleInterestToLink({
      pool,
      tenantId,
      userInput,
      idiomaDestino,
      detectedIntent,
      intentOut,
      catalogReferenceClassification,
      convoCtx,
      buildCatalogRoutingSignal,
      resolveBestLinkForService,
      getServiceDetailsText,
      getServiceAndVariantUrl,
    });

    if (interestToLinkResult.handled) {
      return interestToLinkResult;
    }
  }

  if (!hasPendingCatalogChoice && !shouldBypassCatalogFollowupReuse) {
    const followupRouterResult = await handleFollowupRouter({
      pool,
      tenantId,
      userInput,
      convoCtx,
      isFreshCatalogPriceTurn,
      bestNameMatch,
      resolveServiceIdFromText,
    });

    if (followupRouterResult.handled || followupRouterResult.ctxPatch) {
      return followupRouterResult;
    }
  }

  if (!hasPendingCatalogChoice && !shouldBypassCatalogFollowupReuse) {
    const variantFollowupSameServiceResult =
      await handleVariantFollowupSameService({
        pool,
        userInput,
        idiomaDestino,
        intentOut,
        convoCtx,
        catalogReferenceClassification,
        isFreshCatalogPriceTurn,
      });

    if (variantFollowupSameServiceResult.handled) {
      return variantFollowupSameServiceResult;
    }
  }

  const variantSecondTurnResult = await handleVariantSecondTurn({
    pool,
    tenantId,
    userInput,
    idiomaDestino,
    convoCtx,
    detectedIntent,
    intentOut,
    catalogReferenceClassification,
  });

  if (variantSecondTurnResult.handled) {
    return variantSecondTurnResult;
  }

  const catalogRouteIntent =
    String(intentOut || "").trim().toLowerCase() || null;

  const { hasStructuredTarget } = getCatalogStructuredSignals({
    catalogReferenceClassification,
    convoCtx,
    catalogRouteIntent,
  });

  {
    const firstTurnVariantDetailResult = await handleFirstTurnVariantDetail({
      pool,
      tenantId,
      userInput,
      idiomaDestino,
      convoCtx,
      detectedIntent,
      intentOut,
      isCatalogOverviewTurn,
      catalogReferenceClassification,
      traducirMensaje,
      getCatalogStructuredSignals,
      getCatalogDetailSignals,
      handleLastVariantIncludes,
      resolveFirstTurnServiceDetailTarget,
      handleResolvedServiceDetail,
      normalizeText,
      resolveServiceIdFromText,
    });

    if (firstTurnVariantDetailResult.handled) {
      return firstTurnVariantDetailResult;
    }
  }

  const shouldResolveAmbiguousCandidatesThisTurn =
    !hasConcreteTargetThisTurn &&
    isStructuredCatalogTurn;

  const candidateOptionsFromTurn = shouldResolveAmbiguousCandidatesThisTurn
    ? await (async () => {
        const resolution = await resolveServiceCandidatesFromText(
          pool,
          tenantId,
          userInput,
          { mode: "loose" }
        );

        if (
          resolution.kind !== "ambiguous" ||
          !Array.isArray(resolution.candidates)
        ) {
          return [];
        }

        return resolution.candidates
          .map((item) => ({
            serviceId: String(item.id || "").trim(),
            label: String(item.name || "").trim(),
          }))
          .filter((item) => item.serviceId && item.label)
          .slice(0, maxDisambiguationOptions);
      })()
    : [];

  const catalogRoutingSignal = buildCatalogRoutingSignal({
    intentOut,
    catalogReferenceClassification,
    convoCtx,
    candidateOptionsFromTurn,
  });

  const hasFacetDrivenCatalogIntent =
    detectedFacets?.asksPrices === true ||
    detectedFacets?.asksSchedules === true;

    const hasExplicitCatalogIntent =
    intentOut === "precio" ||
    intentOut === "planes_precios" ||
    intentOut === "info_servicio" ||
    intentOut === "combination_and_price" ||
    intentOut === "catalogo" ||
    intentOut === "catalog";

    const canEnterCatalogFastpath =
    !shouldBypassCatalogFollowupReuse &&
    (
        hasPendingCatalogChoice ||
        Boolean(catalogRoutingSignal?.shouldRouteCatalog) ||
        isStructuredCatalogTurn ||
        hasExplicitCatalogIntent ||
        hasFacetDrivenCatalogIntent
    );

    if (shouldBypassCatalogFollowupReuse) {
    return { handled: false };
    }

    if (!canEnterCatalogFastpath) {
    return { handled: false };
    }

  const catalogFastpathResult = await runCatalogFastpath({
    pool,
    tenantId,
    userInput,
    idiomaDestino,
    convoCtx,
    intentOut,
    detectedIntent,
    infoClave,
    hasStructuredTarget,
    catalogRoutingSignal,
    catalogReferenceClassification,
    facets: detectedFacets || {},
    buildCatalogRoutingSignal,
    normalizeCatalogRole,
    traducirTexto,
    renderGenericPriceSummaryReply,
    extractPlanNamesFromReply,
    canonicalCatalogResolution:
        args.catalogRouteContext?.canonicalCatalogResolution || null,
  });

  if (catalogFastpathResult.handled) {
    return catalogFastpathResult;
  }

  return { handled: false };
}