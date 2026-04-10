//src/lib/channels/engine/fastpath/handleFastpathHybridTurn.ts
import { Pool } from "pg";
import type {
  Canal,
  CommercialSignal,
  IntentRoutingHints,
} from "../../../detectarIntencion";
import type { Lang } from "../clients/clientDb";
import { buildCatalogReferenceClassificationInput } from "../../../catalog/buildCatalogReferenceClassificationInput";
import { classifyCatalogReferenceTurn } from "../../../catalog/classifyCatalogReferenceTurn";
import type { CatalogReferenceClassification } from "../../../catalog/types";
import {
  buildFastpathTurnPolicy,
  type IntentFacets,
} from "./buildFastpathTurnPolicy";
import { getCanonicalCatalogRouteDecision } from "./getCanonicalCatalogRouteDecision";

export type FastpathHybridRoute =
  | "catalog"
  | "business_info"
  | "continue_pipeline";

export type FastpathHybridArgs = {
  pool: Pool;
  tenantId: string;
  canal: Canal;
  idiomaDestino: Lang;
  userInput: string;
  inBooking: boolean;
  convoCtx: any;
  infoClave: string;
  detectedIntent: string | null;
  detectedFacets?: IntentFacets | null;
  detectedCommercial?: CommercialSignal | null;
  detectedRoutingHints?: IntentRoutingHints | null;
  intentFallback: string | null;
  messageId: string | null;
  contactoNorm: string;
  promptBaseMem: string;
  referentialFollowup?: boolean;
  followupNeedsAnchor?: boolean;
  followupEntityKind?: "service" | "plan" | "package" | null;
};

export type FastpathHybridResult = {
  handled: boolean;
  reply?: string;
  replySource?: string;
  intent?: string | null;
  ctxPatch?: any;
  routeTarget?: FastpathHybridRoute;
  routeContext?: {
    catalogReferenceClassification?: CatalogReferenceClassification | null;
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

type HybridDomainDecision = {
  routeTarget: FastpathHybridRoute;
  reason:
    | "pending_catalog_choice"
    | "canonical_catalog_resolution"
    | "catalog_targeted_signal"
    | "catalog_overview_signal"
    | "business_info_signal"
    | "mixed_turn"
    | "guided_entry"
    | "insufficient_signal";
};

function decideHybridDomain(input: {
  hasPendingCatalogChoice: boolean;
  isMixedScheduleAndPriceTurn: boolean;
  isGuidedBusinessEntryTurn: boolean;
  asksPrices: boolean;
  previewShouldRouteCatalog: boolean;
  detectedFacets?: IntentFacets | null;
  detectedRoutingHints?: IntentRoutingHints | null;
  canonicalCatalogRouteDecision: {
    resolutionKind?: string | null;
  };
}): HybridDomainDecision {
  if (input.hasPendingCatalogChoice) {
    return {
      routeTarget: "catalog",
      reason: "pending_catalog_choice",
    };
  }

  if (
    input.canonicalCatalogRouteDecision?.resolutionKind === "resolved_single" ||
    input.canonicalCatalogRouteDecision?.resolutionKind ===
      "resolved_service_variant_ambiguous" ||
    input.canonicalCatalogRouteDecision?.resolutionKind === "ambiguous"
  ) {
    return {
      routeTarget: "catalog",
      reason: "canonical_catalog_resolution",
    };
  }

  if (input.isMixedScheduleAndPriceTurn) {
    return {
      routeTarget: "continue_pipeline",
      reason: "mixed_turn",
    };
  }

  if (input.detectedRoutingHints?.catalogScope === "targeted") {
    return {
      routeTarget: "catalog",
      reason: "catalog_targeted_signal",
    };
  }

  if (
    input.detectedRoutingHints?.businessInfoScope &&
    input.detectedRoutingHints.businessInfoScope !== "none"
  ) {
    return {
      routeTarget: "business_info",
      reason: "business_info_signal",
    };
  }

  if (
    (input.detectedRoutingHints?.catalogScope === "overview" &&
      input.asksPrices) ||
    (input.previewShouldRouteCatalog &&
      input.asksPrices &&
      input.detectedRoutingHints?.businessInfoScope === "none")
  ) {
    return {
      routeTarget: "catalog",
      reason: "catalog_overview_signal",
    };
  }

  if (input.isGuidedBusinessEntryTurn) {
    return {
      routeTarget: "continue_pipeline",
      reason: "guided_entry",
    };
  }

  return {
    routeTarget: "continue_pipeline",
    reason: "insufficient_signal",
  };
}

function buildEffectiveCatalogReferenceClassification(input: {
  baseClassification: CatalogReferenceClassification;
  canonicalCatalogRouteDecision: any;
}): CatalogReferenceClassification {
  const { baseClassification, canonicalCatalogRouteDecision } = input;
  const resolutionKind = String(
    canonicalCatalogRouteDecision?.resolutionKind || "none"
  ).trim();

  const resolutionHit = canonicalCatalogRouteDecision?.resolution?.hit || null;
  const resolvedServiceId =
  resolutionHit &&
    typeof resolutionHit === "object" &&
    "id" in resolutionHit &&
    typeof resolutionHit.id === "string"
      ? resolutionHit.id.trim()
      : "";

  const resolvedServiceName =
    resolutionHit &&
    typeof resolutionHit === "object" &&
    "name" in resolutionHit &&
    typeof resolutionHit.name === "string"
      ? resolutionHit.name.trim()
      : "";

  if (resolutionKind === "resolved_single") {
    return {
      ...baseClassification,
      kind: "entity_specific",
      shouldResolveEntity: true,
      shouldAskDisambiguation: false,
      targetLevel: "service",
      targetServiceId: resolvedServiceId || null,
      targetServiceName: resolvedServiceName || null,
      targetVariantId: null,
      targetVariantName: null,
      targetFamilyKey: null,
      targetFamilyName: null,
      disambiguationType: "none",
      anchorShift: "none",
    };
  }

  if (resolutionKind === "resolved_service_variant_ambiguous") {
    return {
      ...baseClassification,
      kind: "entity_specific",
      shouldResolveEntity: true,
      shouldAskDisambiguation: true,
      targetLevel: "service",
      targetServiceId: resolvedServiceId || null,
      targetServiceName: resolvedServiceName || null,
      targetVariantId: null,
      targetVariantName: null,
      targetFamilyKey: null,
      targetFamilyName: null,
      anchorShift: "none",
    };
  }

  if (resolutionKind === "ambiguous") {
    return {
      ...baseClassification,
      kind: "catalog_family",
      shouldResolveEntity: false,
      shouldAskDisambiguation: true,
      targetLevel: "multi_service",
      targetServiceId: null,
      targetServiceName: null,
      targetVariantId: null,
      targetVariantName: null,
      targetFamilyKey: "canonical_ambiguous_family",
      targetFamilyName: "canonical_ambiguous_family",
      anchorShift: "none",
    };
  }

  return baseClassification;
}

function extractCanonicalCatalogResolutionMeta(input: {
  canonicalCatalogRouteDecision: unknown;
}): {
  resolvedServiceId: string | null;
  resolvedServiceName: string | null;
  variantOptions: Array<{
    variantId: string;
    variantName: string;
  }>;
} {
  const decision = input.canonicalCatalogRouteDecision;

  if (!decision || typeof decision !== "object") {
    return {
      resolvedServiceId: null,
      resolvedServiceName: null,
      variantOptions: [],
    };
  }

  const resolution =
    "resolution" in decision &&
    decision.resolution &&
    typeof decision.resolution === "object"
      ? decision.resolution
      : null;

  const hit =
    resolution &&
    "hit" in resolution &&
    resolution.hit &&
    typeof resolution.hit === "object"
      ? resolution.hit
      : null;

  const resolvedServiceId =
    hit &&
    "id" in hit &&
    typeof hit.id === "string" &&
    hit.id.trim()
      ? hit.id.trim()
      : null;

  const resolvedServiceName =
    hit &&
    "name" in hit &&
    typeof hit.name === "string" &&
    hit.name.trim()
      ? hit.name.trim()
      : null;

  const variantOptionsRaw =
    resolution &&
    "variantOptions" in resolution &&
    Array.isArray(resolution.variantOptions)
      ? resolution.variantOptions
      : [];

  const variantOptions = variantOptionsRaw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const variantId =
        "variantId" in item && typeof item.variantId === "string"
          ? item.variantId.trim()
          : "";

      const variantName =
        "variantName" in item && typeof item.variantName === "string"
          ? item.variantName.trim()
          : "";

      if (!variantId || !variantName) {
        return null;
      }

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
    );

  return {
    resolvedServiceId,
    resolvedServiceName,
    variantOptions,
  };
}

export async function handleFastpathHybridTurn(
  args: FastpathHybridArgs
): Promise<FastpathHybridResult> {
  const {
    pool,
    tenantId,
    canal,
    userInput,
    convoCtx,
    detectedIntent,
    detectedFacets,
    detectedCommercial,
    detectedRoutingHints,
    intentFallback,
    contactoNorm,
    referentialFollowup,
    followupNeedsAnchor,
  } = args;

  const currentIntent = detectedIntent || intentFallback || null;
  const normalizedCurrentIntent = String(currentIntent || "")
    .trim()
    .toLowerCase();

  const asksPrices = detectedFacets?.asksPrices === true;
  const asksSchedules = detectedFacets?.asksSchedules === true;
  const asksLocation = detectedFacets?.asksLocation === true;
  const asksAvailability = detectedFacets?.asksAvailability === true;

  const isMixedScheduleAndPriceTurn = asksSchedules && asksPrices;

  const isGuidedBusinessEntryTurn =
    !asksSchedules &&
    !asksPrices &&
    !asksLocation &&
    !asksAvailability &&
    !detectedCommercial?.wantsBooking &&
    !detectedCommercial?.wantsQuote &&
    !detectedCommercial?.wantsHuman &&
    (
      normalizedCurrentIntent === "duda" ||
      normalizedCurrentIntent === "info_general" ||
      normalizedCurrentIntent === ""
    );

  const hasPendingCatalogChoice =
    Boolean(convoCtx?.pendingCatalogChoice) &&
    (
      convoCtx?.pendingCatalogChoice?.kind === "service_choice" ||
      convoCtx?.pendingCatalogChoice?.kind === "variant_choice"
    );

  const previewClassificationInput = buildCatalogReferenceClassificationInput({
    userText: userInput,
    convoCtx,
    catalogReferenceIntent: null,
    isCatalogOverviewIntent:
      detectedRoutingHints?.catalogScope === "overview" && asksPrices,
    routingHints: detectedRoutingHints || null,
    explicitEntityCandidate: null,
    explicitVariantCandidate: null,
    explicitFamilyCandidate: null,
    structuredComparison: null,
  });

  const previewClassification = classifyCatalogReferenceTurn(
    previewClassificationInput
  );

  const previewPolicy = buildFastpathTurnPolicy({
    classification: previewClassification,
    facets: detectedFacets || null,
    structuredComparison: null,
    convoCtx,
    referentialFollowup,
    followupNeedsAnchor,
  });

  const rawCanonicalCatalogRouteDecision = isMixedScheduleAndPriceTurn
    ? {
        shouldRouteCatalog: true,
        resolutionKind: "none" as const,
        resolution: {
          kind: "none" as const,
          hit: null,
          candidates: [],
        },
      }
    : await getCanonicalCatalogRouteDecision({
        pool,
        tenantId,
        userInput,
      });

  const canonicalResolutionMeta = extractCanonicalCatalogResolutionMeta({
    canonicalCatalogRouteDecision: rawCanonicalCatalogRouteDecision,
  });

  const effectiveCatalogReferenceClassification =
    buildEffectiveCatalogReferenceClassification({
      baseClassification: previewClassification,
      canonicalCatalogRouteDecision: rawCanonicalCatalogRouteDecision,
    });

  const domainDecision = decideHybridDomain({
    hasPendingCatalogChoice,
    isMixedScheduleAndPriceTurn,
    isGuidedBusinessEntryTurn,
    asksPrices,
    previewShouldRouteCatalog: previewPolicy.shouldRouteCatalog === true,
    detectedFacets: detectedFacets || null,
    detectedRoutingHints: detectedRoutingHints || null,
    canonicalCatalogRouteDecision: rawCanonicalCatalogRouteDecision,
  });

  console.log("[FASTPATH_HYBRID][DOMAIN_DECISION]", {
    tenantId,
    canal,
    contactoNorm,
    userInput,
    detectedIntent,
    intentFallback,
    routeTarget: domainDecision.routeTarget,
    reason: domainDecision.reason,
    asksPrices,
    asksSchedules,
    asksLocation,
    asksAvailability,
    hasPendingCatalogChoice,
    previewShouldRouteCatalog: previewPolicy.shouldRouteCatalog === true,
    canonicalCatalogResolutionKind:
      rawCanonicalCatalogRouteDecision?.resolutionKind || "none",
    detectedRoutingHints: detectedRoutingHints || null,
    effectiveCatalogReferenceClassification:
      domainDecision.routeTarget === "catalog"
        ? {
            kind: effectiveCatalogReferenceClassification.kind,
            targetLevel: effectiveCatalogReferenceClassification.targetLevel,
            targetServiceId:
              effectiveCatalogReferenceClassification.targetServiceId || null,
            targetServiceName:
              effectiveCatalogReferenceClassification.targetServiceName || null,
            targetVariantId:
              effectiveCatalogReferenceClassification.targetVariantId || null,
            targetVariantName:
              effectiveCatalogReferenceClassification.targetVariantName || null,
            targetFamilyKey:
              effectiveCatalogReferenceClassification.targetFamilyKey || null,
            shouldResolveEntity:
              effectiveCatalogReferenceClassification.shouldResolveEntity ===
              true,
            shouldAskDisambiguation:
              effectiveCatalogReferenceClassification.shouldAskDisambiguation ===
              true,
            disambiguationType:
              effectiveCatalogReferenceClassification.disambiguationType ||
              "none",
          }
        : null,
  });

  return {
    handled: false,
    routeTarget: domainDecision.routeTarget,
    intent: currentIntent,
    routeContext:
      domainDecision.routeTarget === "catalog"
        ? {
            catalogReferenceClassification:
              effectiveCatalogReferenceClassification,
            canonicalCatalogResolution: {
              resolutionKind:
                String(rawCanonicalCatalogRouteDecision?.resolutionKind || "none"),
              resolvedServiceId: canonicalResolutionMeta.resolvedServiceId,
              resolvedServiceName: canonicalResolutionMeta.resolvedServiceName,
              variantOptions: canonicalResolutionMeta.variantOptions,
            },
          }
        : undefined,
  };
}