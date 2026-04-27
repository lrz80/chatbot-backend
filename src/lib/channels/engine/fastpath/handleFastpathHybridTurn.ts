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
import { decideTurnContinuation } from "../continuation/decideTurnContinuation";
import type { CatalogTurnAugmentation } from "../turn/types";

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
  turnAugmentation?: CatalogTurnAugmentation | null;
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
    needsCatalogClarification?: boolean;
    clarificationSource?: "visual_reference" | null;
  };
};

type HybridDomainDecision = {
  routeTarget: FastpathHybridRoute;
  reason:
    | "pending_catalog_choice"
    | "canonical_catalog_resolution"
    | "catalog_targeted_signal"
    | "catalog_overview_signal"
    | "catalog_anchor_continuation"
    | "business_info_anchor_continuation"
    | "continuation_previous_catalog_domain"
    | "continuation_previous_business_info_domain"
    | "continuation_previous_booking_domain"
    | "business_info_signal"
    | "mixed_turn"
    | "guided_entry"
    | "insufficient_signal";
};

function shouldUseConversationAnchor(input: {
  conversationAnchor: any;
  normalizedCurrentIntent: string;
  hasPendingCatalogChoice: boolean;
  hasVariantSelectionContinuation: boolean;
  inBooking: boolean;
  asksPrices: boolean;
  asksSchedules: boolean;
  asksLocation: boolean;
  asksAvailability: boolean;
  detectedRoutingHints?: IntentRoutingHints | null;
  canonicalCatalogRouteDecision: {
    shouldRouteCatalog?: boolean;
    resolutionKind?: string | null;
  };
  hasCurrentTurnCatalogEvidence: boolean;
}): boolean {
  if (!input.conversationAnchor?.domain) {
    return false;
  }

  if (input.inBooking) {
    return false;
  }

  if (input.hasPendingCatalogChoice || input.hasVariantSelectionContinuation) {
    return true;
  }

  const resolutionKind = String(
    input.canonicalCatalogRouteDecision?.resolutionKind || "none"
  ).trim();

  if (
    resolutionKind === "resolved_single" ||
    resolutionKind === "resolved_service_variant_ambiguous" ||
    resolutionKind === "ambiguous"
  ) {
    return false;
  }

  const hasExplicitBusinessInfoSignal =
    input.asksSchedules ||
    input.asksLocation ||
    input.asksAvailability ||
    (input.detectedRoutingHints?.businessInfoScope &&
      input.detectedRoutingHints.businessInfoScope !== "none");

  if (hasExplicitBusinessInfoSignal) {
    return input.conversationAnchor.domain === "business_info";
  }

  const weakIntent =
    !input.normalizedCurrentIntent ||
    input.normalizedCurrentIntent === "duda";

  if (!weakIntent) {
    return false;
  }

  if (!input.hasCurrentTurnCatalogEvidence) {
    return false;
  }

  if (input.conversationAnchor.domain === "catalog") {
    return true;
  }

  if (input.conversationAnchor.domain === "business_info") {
    return !input.asksPrices;
  }

  return false;
}

function blocksContinuationByExplicitIntent(intent: string | null): boolean {
  const normalized = String(intent || "").trim().toLowerCase();

  return (
    normalized === "no_interesado" ||
    normalized === "despedida"
  );
}

function shouldPrioritizeBusinessInfoDomain(input: {
  asksPrices: boolean;
  asksSchedules: boolean;
  asksLocation: boolean;
  asksAvailability: boolean;
  detectedRoutingHints?: IntentRoutingHints | null;
  canonicalCatalogRouteDecision: {
    shouldRouteCatalog?: boolean;
    resolutionKind?: string | null;
  };
  isGuidedBusinessEntryTurn: boolean;
  isScheduleOnlyTurn: boolean;
  inBooking: boolean;
}): boolean {
  if (input.inBooking) {
    return false;
  }

  if (input.isScheduleOnlyTurn) {
    return true;
  }

  if (input.isGuidedBusinessEntryTurn) {
    return true;
  }

  const hasExplicitBusinessFacet =
    input.asksSchedules || input.asksLocation || input.asksAvailability;

  const hasExplicitBusinessInfoScope =
    Boolean(
      input.detectedRoutingHints?.businessInfoScope &&
        input.detectedRoutingHints.businessInfoScope !== "none"
    );

  if (!hasExplicitBusinessFacet && !hasExplicitBusinessInfoScope) {
    return false;
  }

  if (input.asksPrices) {
    return false;
  }

  const canonicalResolutionKind = String(
    input.canonicalCatalogRouteDecision?.resolutionKind || "none"
  ).trim();

  const isOnlyLexicalCatalogMatch =
    canonicalResolutionKind === "resolved_single" ||
    canonicalResolutionKind === "resolved_service_variant_ambiguous" ||
    canonicalResolutionKind === "ambiguous";

  if (!isOnlyLexicalCatalogMatch) {
    return true;
  }

  return true;
}

function shouldPrioritizeCatalogFromCanonicalResolution(input: {
  canonicalCatalogRouteDecision: {
    shouldRouteCatalog?: boolean;
    resolutionKind?: string | null;
  };
  asksSchedules: boolean;
  asksLocation: boolean;
  asksAvailability: boolean;
  inBooking: boolean;
}): boolean {
  if (input.inBooking) {
    return false;
  }

  if (input.asksSchedules || input.asksLocation || input.asksAvailability) {
    return false;
  }

  const resolutionKind = String(
    input.canonicalCatalogRouteDecision?.resolutionKind || "none"
  ).trim();

  return (
    resolutionKind === "resolved_single" ||
    resolutionKind === "resolved_service_variant_ambiguous" ||
    resolutionKind === "ambiguous"
  );
}

function decideHybridDomain(input: {
  hasPendingCatalogChoice: boolean;
  hasConversationAnchor: boolean;
  hasVariantSelectionContinuation: boolean;
  conversationAnchor: any;
  normalizedCurrentIntent: string;
  inBooking: boolean;
  isMixedScheduleAndPriceTurn: boolean;
  isGuidedBusinessEntryTurn: boolean;
  isScheduleOnlyTurn: boolean;
  asksPrices: boolean;
  asksSchedules: boolean;
  asksLocation: boolean;
  asksAvailability: boolean;
  previewShouldRouteCatalog: boolean;
  previewClassificationKind: string;
  detectedFacets?: IntentFacets | null;
  detectedRoutingHints?: IntentRoutingHints | null;
  canonicalCatalogRouteDecision: {
    shouldRouteCatalog?: boolean;
    resolutionKind?: string | null;
  };
  continuationDecision?: {
    shouldContinue: boolean;
    targetDomain: string | null;
  } | null;
}): HybridDomainDecision {
  if (input.hasPendingCatalogChoice) {
    return {
      routeTarget: "catalog",
      reason: "pending_catalog_choice",
    };
  }

  if (input.continuationDecision?.shouldContinue) {
    if (input.continuationDecision.targetDomain === "catalog") {
      return {
        routeTarget: "catalog",
        reason: "continuation_previous_catalog_domain",
      };
    }

    if (input.continuationDecision.targetDomain === "business_info") {
      return {
        routeTarget: "business_info",
        reason: "continuation_previous_business_info_domain",
      };
    }

    if (input.continuationDecision.targetDomain === "booking") {
      return {
        routeTarget: "continue_pipeline",
        reason: "continuation_previous_booking_domain",
      };
    }
  }

  const canonicalResolutionKind = String(
    input.canonicalCatalogRouteDecision?.resolutionKind || "none"
  ).trim();

  const canonicalShouldRouteCatalog =
    input.canonicalCatalogRouteDecision?.shouldRouteCatalog === true;

  const mustPrioritizeCatalogFromCanonicalResolution =
    shouldPrioritizeCatalogFromCanonicalResolution({
      canonicalCatalogRouteDecision: input.canonicalCatalogRouteDecision,
      asksSchedules: input.asksSchedules,
      asksLocation: input.asksLocation,
      asksAvailability: input.asksAvailability,
      inBooking: input.inBooking,
    });

  if (mustPrioritizeCatalogFromCanonicalResolution) {
    return {
      routeTarget: "catalog",
      reason: "canonical_catalog_resolution",
    };
  }

  const mustPrioritizeBusinessInfo = shouldPrioritizeBusinessInfoDomain({
    asksPrices: input.asksPrices,
    asksSchedules: input.asksSchedules,
    asksLocation: input.asksLocation,
    asksAvailability: input.asksAvailability,
    detectedRoutingHints: input.detectedRoutingHints || null,
    canonicalCatalogRouteDecision: input.canonicalCatalogRouteDecision,
    isGuidedBusinessEntryTurn: input.isGuidedBusinessEntryTurn,
    isScheduleOnlyTurn: input.isScheduleOnlyTurn,
    inBooking: input.inBooking,
  });

  if (mustPrioritizeBusinessInfo) {
    return {
      routeTarget: "business_info",
      reason: "business_info_signal",
    };
  }

  if (input.isMixedScheduleAndPriceTurn) {
    return {
      routeTarget: "continue_pipeline",
      reason: "mixed_turn",
    };
  }

  const hasCurrentTurnCatalogEvidence =
    canonicalResolutionKind === "resolved_single" ||
    canonicalResolutionKind === "resolved_service_variant_ambiguous" ||
    canonicalResolutionKind === "ambiguous";

  if (
    shouldUseConversationAnchor({
      conversationAnchor: input.conversationAnchor,
      normalizedCurrentIntent: input.normalizedCurrentIntent,
      hasPendingCatalogChoice: input.hasPendingCatalogChoice,
      hasVariantSelectionContinuation: input.hasVariantSelectionContinuation,
      inBooking: input.inBooking,
      asksPrices: input.asksPrices,
      asksSchedules: input.asksSchedules,
      asksLocation: input.asksLocation,
      asksAvailability: input.asksAvailability,
      detectedRoutingHints: input.detectedRoutingHints || null,
      canonicalCatalogRouteDecision: input.canonicalCatalogRouteDecision,
      hasCurrentTurnCatalogEvidence,
    })
  ) {
    return {
      routeTarget:
        input.conversationAnchor?.domain === "business_info"
          ? "business_info"
          : "catalog",
      reason:
        input.conversationAnchor?.domain === "business_info"
          ? "business_info_anchor_continuation"
          : "catalog_anchor_continuation",
    };
  }

  const hasExplicitCatalogOverviewSignal =
    input.asksPrices &&
    input.detectedRoutingHints?.catalogScope === "overview" &&
    !input.asksSchedules &&
    !input.asksLocation &&
    !input.asksAvailability;

  if (hasExplicitCatalogOverviewSignal) {
    return {
      routeTarget: "catalog",
      reason: "catalog_overview_signal",
    };
  }

  const hasExplicitCatalogTargetedSignal =
    input.previewShouldRouteCatalog === true &&
    input.detectedRoutingHints?.catalogScope === "targeted" &&
    !input.asksSchedules &&
    !input.asksLocation &&
    !input.asksAvailability;

  if (hasExplicitCatalogTargetedSignal) {
    return {
      routeTarget: "catalog",
      reason: "catalog_targeted_signal",
    };
  }

  if (
    (canonicalResolutionKind === "resolved_single" ||
      canonicalResolutionKind === "resolved_service_variant_ambiguous") &&
    !input.isGuidedBusinessEntryTurn &&
    !input.isScheduleOnlyTurn &&
    input.asksPrices
  ) {
    return {
      routeTarget: "catalog",
      reason: "canonical_catalog_resolution",
    };
  }

  if (
    canonicalResolutionKind === "ambiguous" &&
    canonicalShouldRouteCatalog &&
    input.asksPrices
  ) {
    return {
      routeTarget: "catalog",
      reason: "canonical_catalog_resolution",
    };
  }

  return {
    routeTarget: "continue_pipeline",
    reason: "insufficient_signal",
  };
}

function normalizeCanonicalCatalogResolution(decision: unknown): {
  resolutionKind: string;
  resolvedServiceId: string | null;
  resolvedServiceName: string | null;
  variantOptions: Array<{
    variantId: string;
    variantName: string;
  }>;
} {
  const obj =
    decision && typeof decision === "object"
      ? (decision as Record<string, unknown>)
      : null;

  const resolutionKind =
    typeof obj?.resolutionKind === "string" && obj.resolutionKind.trim()
      ? obj.resolutionKind.trim()
      : "none";

  const resolution =
    obj?.resolution && typeof obj.resolution === "object"
      ? (obj.resolution as Record<string, unknown>)
      : null;

  const hit =
    resolution?.hit && typeof resolution.hit === "object"
      ? (resolution.hit as Record<string, unknown>)
      : null;

  const topLevelResolvedServiceId =
    typeof obj?.resolvedServiceId === "string" && obj.resolvedServiceId.trim()
      ? obj.resolvedServiceId.trim()
      : null;

  const nestedResolvedServiceId =
    typeof hit?.id === "string" && hit.id.trim()
      ? hit.id.trim()
      : null;

  const resolvedServiceId =
    topLevelResolvedServiceId || nestedResolvedServiceId || null;

  const topLevelResolvedServiceName =
    typeof obj?.resolvedServiceName === "string" && obj.resolvedServiceName.trim()
      ? obj.resolvedServiceName.trim()
      : null;

  const nestedResolvedServiceName =
    typeof hit?.name === "string" && hit.name.trim()
      ? hit.name.trim()
      : null;

  const resolvedServiceName =
    topLevelResolvedServiceName || nestedResolvedServiceName || null;

  const rawVariantOptions = Array.isArray(obj?.variantOptions)
    ? obj.variantOptions
    : Array.isArray(resolution?.variantOptions)
    ? resolution.variantOptions
    : [];

  const variantOptions = rawVariantOptions
    .map((item) => {
      if (!item || typeof item !== "object") return null;

      const row = item as Record<string, unknown>;

      const variantId =
        typeof row.variantId === "string" && row.variantId.trim()
          ? row.variantId.trim()
          : null;

      const variantName =
        typeof row.variantName === "string" && row.variantName.trim()
          ? row.variantName.trim()
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
    );

  return {
    resolutionKind,
    resolvedServiceId,
    resolvedServiceName,
    variantOptions,
  };
}

function buildEffectiveCatalogReferenceClassification(input: {
  baseClassification: CatalogReferenceClassification;
  canonicalCatalogRouteDecision: unknown;
}): CatalogReferenceClassification {
  const { baseClassification, canonicalCatalogRouteDecision } = input;

  const normalized = normalizeCanonicalCatalogResolution(
    canonicalCatalogRouteDecision
  );

  if (normalized.resolutionKind === "resolved_single") {
    return {
      ...baseClassification,
      kind: "entity_specific",
      shouldResolveEntity: true,
      shouldAskDisambiguation: false,
      targetLevel: "service",
      targetServiceId: normalized.resolvedServiceId,
      targetServiceName: normalized.resolvedServiceName,
      targetVariantId: null,
      targetVariantName: null,
      targetFamilyKey: null,
      targetFamilyName: null,
      disambiguationType: "none",
      anchorShift: "none",
    };
  }

  if (normalized.resolutionKind === "resolved_service_variant_ambiguous") {
    return {
      ...baseClassification,
      kind: "entity_specific",
      shouldResolveEntity: true,
      shouldAskDisambiguation: true,
      targetLevel: "service",
      targetServiceId: normalized.resolvedServiceId,
      targetServiceName: normalized.resolvedServiceName,
      targetVariantId: null,
      targetVariantName: null,
      targetFamilyKey: null,
      targetFamilyName: null,
      anchorShift: "none",
    };
  }

  if (normalized.resolutionKind === "ambiguous") {
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
  const normalized = normalizeCanonicalCatalogResolution(
    input.canonicalCatalogRouteDecision
  );

  return {
    resolvedServiceId: normalized.resolvedServiceId,
    resolvedServiceName: normalized.resolvedServiceName,
    variantOptions: normalized.variantOptions,
  };
}

function buildPendingCatalogChoiceClassification(convoCtx: any) {
  const pending = convoCtx?.pendingCatalogChoice;

  if (!pending?.kind) return null;

  if (pending.kind === "service_choice") {
    return {
      kind: "entity_specific",
      targetLevel: "service",
      targetServiceId:
        String(pending.selectedServiceId || pending.serviceId || "").trim() ||
        null,
      targetServiceName:
        String(pending.selectedServiceName || pending.serviceName || "").trim() ||
        null,
      targetVariantId: null,
      targetVariantName: null,
      targetFamilyKey: null,
      shouldResolveEntity: true,
      shouldAskDisambiguation: false,
      disambiguationType: "none",
    };
  }

  if (pending.kind === "variant_choice") {
    return {
      kind: "variant_specific",
      targetLevel: "variant",
      targetServiceId:
        String(pending.selectedServiceId || pending.serviceId || "").trim() ||
        null,
      targetServiceName:
        String(pending.selectedServiceName || pending.serviceName || "").trim() ||
        null,
      targetVariantId: null,
      targetVariantName: null,
      targetFamilyKey: null,
      shouldResolveEntity: false,
      shouldAskDisambiguation: false,
      disambiguationType: "variant",
    };
  }

  return null;
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
    turnAugmentation,
  } = args;

  const currentIntent = detectedIntent || intentFallback || null;
  const normalizedCurrentIntent = String(currentIntent || "")
    .trim()
    .toLowerCase();

  const catalogResolvableText =
    String(turnAugmentation?.catalogResolvableText || "").trim() ||
    String(userInput || "").trim();

  const hasVisualCatalogContext =
    turnAugmentation?.hasVisualCatalogContext === true;

  const asksPrices = detectedFacets?.asksPrices === true;
  const asksSchedules = detectedFacets?.asksSchedules === true;
  const asksLocation = detectedFacets?.asksLocation === true;
  const asksAvailability = detectedFacets?.asksAvailability === true;

  const isMixedScheduleAndPriceTurn = asksSchedules && asksPrices;

  const hasPendingCatalogChoice =
    Boolean(convoCtx?.pendingCatalogChoice) &&
    (
      convoCtx?.pendingCatalogChoice?.kind === "service_choice" ||
      convoCtx?.pendingCatalogChoice?.kind === "variant_choice"
    );

  const hasVariantSelectionContinuation =
    Boolean(convoCtx?.expectingVariant) ||
    (
      Array.isArray(convoCtx?.presentedVariantOptions) &&
      convoCtx.presentedVariantOptions.length > 0
    ) ||
    (
      Array.isArray(convoCtx?.presented_variant_options) &&
      convoCtx.presented_variant_options.length > 0
    );

  const isScheduleOnlyTurn =
    asksSchedules === true &&
    asksPrices !== true &&
    asksLocation !== true &&
    asksAvailability !== true;

  const isGuidedBusinessEntryTurn =
    !asksSchedules &&
    !asksPrices &&
    !asksLocation &&
    !asksAvailability &&
    !detectedCommercial?.wantsBooking &&
    !detectedCommercial?.wantsQuote &&
    !detectedCommercial?.wantsHuman &&
    !hasPendingCatalogChoice &&
    !hasVariantSelectionContinuation &&
    (
      normalizedCurrentIntent === "duda" ||
      normalizedCurrentIntent === "info_general" ||
      normalizedCurrentIntent === "info_servicio" ||
      normalizedCurrentIntent === ""
    );

  const conversationAnchor = convoCtx?.conversationAnchor ?? null;

  const hasConversationAnchor =
    Boolean(conversationAnchor?.domain) ||
    Boolean(convoCtx?.lastEntityId) ||
    Boolean(convoCtx?.last_entity_id) ||
    Boolean(convoCtx?.last_service_id) ||
    Boolean(convoCtx?.selectedServiceId) ||
    Boolean(convoCtx?.last_service_ref?.service_id) ||
    Boolean(convoCtx?.last_variant_id);

  const hasActiveCatalogContinuation =
    hasPendingCatalogChoice || hasVariantSelectionContinuation;

  const previewClassificationInput = buildCatalogReferenceClassificationInput({
    userText: catalogResolvableText,
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
        userInput: catalogResolvableText,
      });

  const canonicalResolutionMeta = extractCanonicalCatalogResolutionMeta({
    canonicalCatalogRouteDecision: rawCanonicalCatalogRouteDecision,
  });

  const effectiveCatalogReferenceClassification =
    buildEffectiveCatalogReferenceClassification({
      baseClassification: previewClassification,
      canonicalCatalogRouteDecision: rawCanonicalCatalogRouteDecision,
    });

  const rawContinuationDecision = decideTurnContinuation({
    userInput,
    continuationContext: convoCtx?.continuationContext ?? null,
    currentTurnSignals: {
      detectedIntent: currentIntent,
      hasStrongStandaloneIntent:
        Boolean(currentIntent && normalizedCurrentIntent !== "duda") ||
        Boolean(detectedRoutingHints?.catalogScope && detectedRoutingHints.catalogScope !== "none") ||
        Boolean(
          detectedRoutingHints?.businessInfoScope &&
            detectedRoutingHints.businessInfoScope !== "none"
        ),
      hasResolvedEntity: Boolean(
        canonicalResolutionMeta.resolvedServiceId
      ),
      asksPrices,
      asksSchedules,
      asksLocation,
      asksAvailability,
      wantsBooking: Boolean(detectedCommercial?.wantsBooking),
    },
  });

  const continuationDecision = blocksContinuationByExplicitIntent(currentIntent)
    ? {
        shouldContinue: false,
        confidence: 1,
        targetDomain: null,
        reason: "explicit_exit_intent",
      }
    : rawContinuationDecision;

    const canonicalResolutionKind = String(
    rawCanonicalCatalogRouteDecision?.resolutionKind || "none"
  ).trim();

  const unresolvedVisualCatalogReference =
    hasVisualCatalogContext &&
    canonicalResolutionKind !== "resolved_single" &&
    canonicalResolutionKind !== "resolved_service_variant_ambiguous" &&
    (
      normalizedCurrentIntent === "info_servicio" ||
      normalizedCurrentIntent === "precio" ||
      normalizedCurrentIntent === "duda" ||
      normalizedCurrentIntent === ""
    );

  if (unresolvedVisualCatalogReference) {
    console.log("[FASTPATH_HYBRID][VISUAL_CATALOG_UNRESOLVED]", {
      tenantId,
      canal,
      contactoNorm,
      userInput,
      catalogResolvableText,
      canonicalResolutionKind,
    });

    return {
      handled: false,
      routeTarget: "catalog",
      intent: currentIntent,
      routeContext: {
        catalogReferenceClassification: effectiveCatalogReferenceClassification,
        canonicalCatalogResolution: {
          resolutionKind: canonicalResolutionKind,
          resolvedServiceId: canonicalResolutionMeta.resolvedServiceId,
          resolvedServiceName: canonicalResolutionMeta.resolvedServiceName,
          variantOptions: canonicalResolutionMeta.variantOptions,
        },
        needsCatalogClarification: true,
        clarificationSource: "visual_reference",
      } as any,
    };
  }

  const domainDecision = decideHybridDomain({
    hasPendingCatalogChoice,
    hasConversationAnchor,
    hasVariantSelectionContinuation,
    conversationAnchor,
    normalizedCurrentIntent,
    inBooking: args.inBooking,
    isMixedScheduleAndPriceTurn,
    isGuidedBusinessEntryTurn,
    isScheduleOnlyTurn,
    asksPrices,
    asksSchedules,
    asksLocation,
    asksAvailability,
    previewShouldRouteCatalog: previewPolicy.shouldRouteCatalog === true,
    previewClassificationKind: previewClassification.kind,
    detectedFacets: detectedFacets || null,
    detectedRoutingHints: detectedRoutingHints || null,
    canonicalCatalogRouteDecision: rawCanonicalCatalogRouteDecision,
    continuationDecision,
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
    continuationDecision,
    asksPrices,
    asksSchedules,
    asksLocation,
    asksAvailability,
    hasPendingCatalogChoice,
    hasActiveCatalogContinuation,
    hasConversationAnchor,
    hasVariantSelectionContinuation,
    previewShouldRouteCatalog: previewPolicy.shouldRouteCatalog === true,
    canonicalShouldRouteCatalog:
      rawCanonicalCatalogRouteDecision?.shouldRouteCatalog === true,
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