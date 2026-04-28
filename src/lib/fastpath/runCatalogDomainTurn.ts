//src/lib/fastpath/runCatalogDomainTurn.ts
import type { Pool } from "pg";

import type { Canal } from "../detectarIntencion";
import type { Lang } from "../channels/engine/clients/clientDb";

import { traducirTexto } from "../traducirTexto";

import { renderGenericPriceSummaryReply } from "../services/pricing/renderGenericPriceSummaryReply";

import type { CatalogReferenceClassification } from "../catalog/types";
import { buildCatalogRoutingSignal } from "../catalog/buildCatalogRoutingSignal";
import { runCatalogFastpath } from "./handlers/catalog/runCatalogFastpath";

import {
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

  if (
    canonical.resolutionKind === "resolved_family" ||
    canonical.resolutionKind === "ambiguous_family" ||
    canonical.resolutionKind === "ambiguous_entities" ||
    canonical.resolutionKind === "ambiguous"
  ) {
    return {
      ...seed,
      kind: "catalog_family",
      targetLevel: "multi_service",
      shouldResolveEntity: false,
      shouldAskDisambiguation: true,
      targetServiceId: null,
      targetServiceName: null,
      targetVariantId: null,
      targetVariantName: null,
      targetFamilyKey: "canonical_ambiguous_family",
      targetFamilyName: null,
      disambiguationType: "service_choice",
      anchorShift: "none",
    };
  }

  return base;
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
  } = args;

  void canal;
  void infoClave;

  const convoCtx = initialConvoCtx;

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

  const isStructuredCatalogTurn =
    catalogReferenceKind === "catalog_overview" ||
    catalogReferenceKind === "catalog_family" ||
    catalogReferenceKind === "entity_specific" ||
    catalogReferenceKind === "variant_specific" ||
    catalogReferenceKind === "referential_followup" ||
    catalogReferenceKind === "comparison";

  const baseCatalogRoutingSignal = buildCatalogRoutingSignal({
    intentOut,
    catalogReferenceClassification: effectiveCatalogReferenceClassification,
    convoCtx,
    candidateOptionsFromTurn: [],
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

  const hasStructuredTarget =
    Boolean(effectiveCatalogReferenceClassification?.targetServiceId) ||
    Boolean(effectiveCatalogReferenceClassification?.targetVariantId) ||
    Boolean(effectiveCatalogReferenceClassification?.targetFamilyKey) ||
    isStructuredCatalogTurn ||
    hasPendingCatalogChoice;

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