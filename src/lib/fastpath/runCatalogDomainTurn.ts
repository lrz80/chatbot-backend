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

import { renderGenericPriceSummaryReply } from "../services/pricing/renderGenericPriceSummaryReply";

import type { CatalogReferenceClassification } from "../catalog/types";
import { buildCatalogRoutingSignal } from "../catalog/buildCatalogRoutingSignal";
import { runCatalogFastpath } from "./handlers/catalog/runCatalogFastpath";

import { getCatalogStructuredSignals } from "./handlers/catalog/getCatalogStructuredSignals";
import { getCatalogDetailSignals } from "./handlers/catalog/getCatalogDetailSignals";
import { getCatalogRoutingState } from "./handlers/catalog/getCatalogRoutingState";
import { handleVariantSecondTurn } from "./handlers/catalog/handleVariantSecondTurn";
import { handleLastVariantIncludes } from "./handlers/catalog/handleLastVariantIncludes";
import { handleResolvedServiceDetail } from "./handlers/catalog/handleResolvedServiceDetail";
import { handleVariantFollowupSameService } from "./handlers/catalog/handleVariantFollowupSameService";
import { handlePickFromLastList } from "./handlers/catalog/handlePickFromLastList";

import { handleFastpathDismiss } from "./handlers/catalog/handleFastpathDismiss";
import { handlePendingLinkSelection } from "./handlers/catalog/handlePendingLinkSelection";
import { handlePendingLinkGuardrail } from "./handlers/catalog/handlePendingLinkGuardrail";
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

type CanonicalCatalogResolution = {
  resolutionKind: string;
  resolvedServiceId?: string | null;
  resolvedServiceName?: string | null;
  variantOptions?: Array<{
    variantId: string;
    variantName: string;
  }>;
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

function normalizeCanonicalCatalogResolution(
  input?: CanonicalCatalogResolution | null
): CanonicalCatalogResolution | null {
  if (!input || typeof input !== "object") return null;

  const resolutionKind = String(input.resolutionKind || "").trim();
  if (!resolutionKind) return null;

  const resolvedServiceId =
    typeof input.resolvedServiceId === "string" && input.resolvedServiceId.trim()
      ? input.resolvedServiceId.trim()
      : null;

  const resolvedServiceName =
    typeof input.resolvedServiceName === "string" &&
    input.resolvedServiceName.trim()
      ? input.resolvedServiceName.trim()
      : null;

  const variantOptions = Array.isArray(input.variantOptions)
    ? input.variantOptions
        .map((item) => {
          if (!item || typeof item !== "object") return null;

          const variantId =
            typeof item.variantId === "string" && item.variantId.trim()
              ? item.variantId.trim()
              : null;

          const variantName =
            typeof item.variantName === "string" && item.variantName.trim()
              ? item.variantName.trim()
              : null;

          if (!variantId || !variantName) return null;

          return {
            variantId,
            variantName,
          };
        })
        .filter(
          (
            item
          ): item is {
            variantId: string;
            variantName: string;
          } => Boolean(item)
        )
    : [];

  return {
    resolutionKind,
    resolvedServiceId,
    resolvedServiceName,
    variantOptions,
  };
}

function buildEffectiveCatalogReferenceClassificationFromCanonical(input: {
  baseClassification?: CatalogReferenceClassification;
  canonicalResolution?: CanonicalCatalogResolution | null;
}): CatalogReferenceClassification | undefined {
  const base = input.baseClassification;
  const canonical = normalizeCanonicalCatalogResolution(
    input.canonicalResolution
  );

  if (!base && !canonical) return undefined;
  if (!canonical) return base;

  const seed = (
    base ||
    ({
      kind: "entity_specific",
      targetLevel: "service",
      shouldResolveEntity: false,
      shouldAskDisambiguation: false,
      targetServiceId: null,
      targetServiceName: null,
      targetVariantId: null,
      targetVariantName: null,
      targetFamilyKey: null,
      targetFamilyName: null,
      disambiguationType: "none",
      anchorShift: "none",
    } as CatalogReferenceClassification)
  );

  if (canonical.resolutionKind === "resolved_service_variant_ambiguous") {
    return {
      ...seed,
      kind: "entity_specific",
      targetLevel: "service",
      shouldResolveEntity: true,
      shouldAskDisambiguation: true,
      targetServiceId: canonical.resolvedServiceId || null,
      targetServiceName: canonical.resolvedServiceName || null,
      targetVariantId: null,
      targetVariantName: null,
      targetFamilyKey: null,
      targetFamilyName: null,
      anchorShift: "none",
    };
  }

  if (canonical.resolutionKind === "resolved_single") {
    return {
      ...seed,
      kind: "entity_specific",
      targetLevel: "service",
      shouldResolveEntity: true,
      shouldAskDisambiguation: false,
      targetServiceId: canonical.resolvedServiceId || null,
      targetServiceName: canonical.resolvedServiceName || null,
      targetVariantId: null,
      targetVariantName: null,
      targetFamilyKey: null,
      targetFamilyName: null,
      anchorShift: "none",
    };
  }

if (canonical.resolutionKind === "ambiguous") {
    return {
      ...seed,
      kind: "referential_followup",
      targetLevel: "multi_service",
      shouldResolveEntity: false,
      shouldAskDisambiguation: true,
      targetServiceId: null,
      targetServiceName: null,
      targetVariantId: null,
      targetVariantName: null,
      targetFamilyKey: null,
      targetFamilyName: null,
      disambiguationType: "service_choice",
      anchorShift: "none",
    };
  }

  return base;
}

function shouldUseCatalogAnchorResolution(input: {
  convoCtx: any;
  intentOut: string | null;
  hasPendingCatalogChoice: boolean;
  hasConcreteTargetThisTurn: boolean;
  isStructuredCatalogTurn: boolean;
}): boolean {
  const anchor = input.convoCtx?.conversationAnchor ?? null;

  if (!anchor || anchor.domain !== "catalog") {
    return false;
  }

  if (input.hasPendingCatalogChoice) {
    return false;
  }

  if (input.hasConcreteTargetThisTurn) {
    return false;
  }

  const normalizedIntent = String(input.intentOut || "").trim().toLowerCase();

  return (
    !normalizedIntent ||
    normalizedIntent === "duda" ||
    input.isStructuredCatalogTurn
  );
}

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

  const canonicalCatalogResolution = normalizeCanonicalCatalogResolution(
    args.catalogRouteContext?.canonicalCatalogResolution || null
  );

  const hasPendingCatalogChoice =
    Boolean(initialConvoCtx?.pendingCatalogChoice) &&
    (initialConvoCtx?.pendingCatalogChoice?.kind === "service_choice" ||
        initialConvoCtx?.pendingCatalogChoice?.kind === "variant_choice");

  const baseEffectiveCatalogReferenceClassification =
    buildEffectiveCatalogReferenceClassificationFromCanonical({
        baseClassification: catalogReferenceClassification,
        canonicalResolution: canonicalCatalogResolution,
    });

  const normalizedUserInput = String(userInput || "").trim();
  const isExplicitPendingChoiceSelection = /^[1-9]\d*$/.test(normalizedUserInput);

  const effectiveCatalogReferenceClassification =
    hasPendingCatalogChoice && isExplicitPendingChoiceSelection
      ? undefined
      : baseEffectiveCatalogReferenceClassification;

  const q = userInput.toLowerCase().trim();

  if (inBooking) {
    return { handled: false };
  }

  const intentOut = String(detectedIntent || "").trim() || null;

  const catalogReferenceKind =
    effectiveCatalogReferenceClassification?.kind ?? "none";

  const hasConcreteTargetThisTurn =
    Boolean(effectiveCatalogReferenceClassification?.targetServiceId) ||
    Boolean(effectiveCatalogReferenceClassification?.targetVariantId) ||
    Boolean(effectiveCatalogReferenceClassification?.targetFamilyKey);

  const conversationAnchor = convoCtx?.conversationAnchor ?? null;

  const anchorServiceId =
    String(
      conversationAnchor?.entityId ||
      convoCtx?.last_service_id ||
      convoCtx?.selectedServiceId ||
      ""
    ).trim() || null;

  const anchorVariantId =
    String(
      conversationAnchor?.variantId ||
      convoCtx?.last_variant_id ||
      ""
    ).trim() || null;

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

  const isCatalogOverviewTurn = catalogReferenceKind === "catalog_overview";
  const isCatalogFamilyTurn = catalogReferenceKind === "catalog_family";
  const isEntitySpecificTurn = catalogReferenceKind === "entity_specific";
  const isVariantSpecificTurn = catalogReferenceKind === "variant_specific";
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
    catalogReferenceClassification: effectiveCatalogReferenceClassification,
    convoCtx,
    buildCatalogRoutingSignal,
  });

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

  if (!hasPendingCatalogChoice) {
    const pickFromLastListResult = await handlePickFromLastList({
      userInput,
      idiomaDestino,
      convoCtx,
      tenantId,
      pool,
      detectedIntent,
      catalogReferenceClassification: effectiveCatalogReferenceClassification,
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

  if (
    shouldUseCatalogAnchorResolution({
      convoCtx,
      intentOut,
      hasPendingCatalogChoice,
      hasConcreteTargetThisTurn,
      isStructuredCatalogTurn,
    }) &&
    anchorServiceId
  ) {
    const anchorClassification: CatalogReferenceClassification = {
      kind: "entity_specific",
      targetLevel: "service",
      shouldResolveEntity: true,
      shouldAskDisambiguation: false,
      targetServiceId: anchorServiceId,
      targetServiceName:
        String(conversationAnchor?.entityName || convoCtx?.last_service_name || "").trim() || null,
      targetVariantId: anchorVariantId,
      targetVariantName:
        String(conversationAnchor?.variantName || convoCtx?.last_variant_name || "").trim() || null,
      targetFamilyKey: null,
      targetFamilyName: null,
      disambiguationType: "none",
      anchorShift: "none",
    } as CatalogReferenceClassification;

    const anchorRoutingSignal = buildCatalogRoutingSignal({
      intentOut:
        String(intentOut || "").trim().toLowerCase() === "duda"
          ? String(conversationAnchor?.intent || "info_servicio").trim().toLowerCase()
          : intentOut,
      catalogReferenceClassification: anchorClassification,
      convoCtx: {
        ...(convoCtx || {}),
        selectedServiceId: anchorServiceId,
        last_service_id: anchorServiceId,
        ...(anchorVariantId ? { last_variant_id: anchorVariantId } : {}),
      },
      candidateOptionsFromTurn: [],
    });

    const anchorCatalogResult = await runCatalogFastpath({
      pool,
      tenantId,
      userInput,
      idiomaDestino,
      convoCtx: {
        ...(convoCtx || {}),
        selectedServiceId: anchorServiceId,
        last_service_id: anchorServiceId,
        ...(anchorVariantId ? { last_variant_id: anchorVariantId } : {}),
      },
      intentOut:
        String(intentOut || "").trim().toLowerCase() === "duda"
          ? String(conversationAnchor?.intent || "info_servicio").trim().toLowerCase()
          : intentOut,
      detectedIntent,
      infoClave,
      hasStructuredTarget: true,
      catalogRoutingSignal: anchorRoutingSignal,
      catalogReferenceClassification: anchorClassification,
      facets: detectedFacets || {},
      buildCatalogRoutingSignal,
      normalizeCatalogRole,
      traducirTexto,
      renderGenericPriceSummaryReply,
      extractPlanNamesFromReply,
      canonicalCatalogResolution:
        args.catalogRouteContext?.canonicalCatalogResolution || null,
    });

    if (anchorCatalogResult.handled) {
      return anchorCatalogResult;
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
        catalogReferenceClassification: effectiveCatalogReferenceClassification,
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
    catalogReferenceClassification: effectiveCatalogReferenceClassification,
  });

  if (variantSecondTurnResult.handled) {
    return variantSecondTurnResult;
  }

  const catalogRouteIntent =
    String(intentOut || "").trim().toLowerCase() || null;

  const { hasStructuredTarget } = getCatalogStructuredSignals({
    catalogReferenceClassification: effectiveCatalogReferenceClassification,
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
      catalogReferenceClassification: effectiveCatalogReferenceClassification,
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
    !hasConcreteTargetThisTurn && isStructuredCatalogTurn;

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

  if (
    canonicalCatalogResolution?.resolutionKind === "ambiguous" &&
    candidateOptionsFromTurn.length > 0
  ) {
    return {
      handled: true,
      source: "catalog_disambiguation_db",
      intent: "service_choice",
      reply: "",
      catalogPayload: {
        kind: "service_choice",
        options: candidateOptionsFromTurn.map((item, index) => ({
          index: index + 1,
          serviceId: item.serviceId,
          label: item.label,
        })),
      },
      ctxPatch: {
        pendingCatalogChoice: {
          kind: "service_choice",
          options: candidateOptionsFromTurn.map((item, index) => ({
            index: index + 1,
            serviceId: item.serviceId,
            variantId: null,
            label: item.label,
            serviceName: item.label,
          })),
        },
        pendingCatalogChoiceAt: Date.now(),
        last_bot_action: "catalog_service_choice",
      },
    } as any;
  }

  const baseCatalogRoutingSignal = buildCatalogRoutingSignal({
    intentOut,
    catalogReferenceClassification: effectiveCatalogReferenceClassification,
    convoCtx,
    candidateOptionsFromTurn,
  });

  const catalogRoutingSignal =
    canonicalCatalogResolution?.resolutionKind ===
      "resolved_service_variant_ambiguous" &&
    canonicalCatalogResolution.resolvedServiceId
      ? {
          ...baseCatalogRoutingSignal,
          shouldRouteCatalog: true,
          referenceKind: "entity_specific",
          source: "canonical_catalog_resolution",
          targetServiceId: canonicalCatalogResolution.resolvedServiceId,
          targetServiceName:
            canonicalCatalogResolution.resolvedServiceName || null,
          targetVariantId: null,
          targetVariantName: null,
          targetFamilyKey: null,
          targetFamilyName: null,
          targetLevel: "service",
          disambiguationType: "variant",
          anchorShift: "none",
        }
      : baseCatalogRoutingSignal;

  const hasCanonicalCatalogEntry =
    Boolean(catalogRoutingSignal?.shouldRouteCatalog) ||
    canonicalCatalogResolution?.resolutionKind === "resolved_single" ||
    canonicalCatalogResolution?.resolutionKind === "resolved_service_variant_ambiguous";

  const canEnterCatalogFastpath =
    !shouldBypassCatalogFollowupReuse &&
    (
      hasPendingCatalogChoice ||
      hasCanonicalCatalogEntry ||
      (
        isStructuredCatalogTurn &&
        (
          hasConcreteTargetThisTurn ||
          canonicalCatalogResolution?.resolutionKind === "resolved_single" ||
          canonicalCatalogResolution?.resolutionKind === "resolved_service_variant_ambiguous" ||
          canonicalCatalogResolution?.resolutionKind === "ambiguous"
        )
      )
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
    catalogReferenceClassification: effectiveCatalogReferenceClassification,
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