//src/lib/channels/engine/fastpath/handleFastpathHybridTurn.ts
import { Pool } from "pg";
import type {
  Canal,
  CommercialSignal,
  IntentRoutingHints,
} from "../../../detectarIntencion";
import type { Lang } from "../clients/clientDb";
import { runFastpath } from "../../../fastpath/runFastpath";
import { naturalizeSecondaryOptionsLine } from "../../../fastpath/naturalizeSecondaryOptions";

import { buildCatalogReferenceClassificationInput } from "../../../catalog/buildCatalogReferenceClassificationInput";
import { classifyCatalogReferenceTurn } from "../../../catalog/classifyCatalogReferenceTurn";
import { buildCatalogRoutingSignal } from "../../../catalog/buildCatalogRoutingSignal";

import {
  buildFastpathTurnPolicy,
  type IntentFacets,
} from "./buildFastpathTurnPolicy";

import { getFastpathCatalogSignals } from "./getFastpathCatalogSignals";
import { getPreResolvedCatalogService } from "./getPreResolvedCatalogService";
import { buildFastpathReplyPolicy } from "./buildFastpathReplyPolicy";
import { renderFastpathDmReply } from "./renderFastpathDmReply";
import { getStructuredServiceForFastpath } from "./getStructuredServiceForFastpath";
import { getFastpathImmediateReturn } from "./getFastpathImmediateReturn";
import { getFastpathPostRunDecision } from "./getFastpathPostRunDecision";
import { applyStructuredServicePersistence } from "./applyStructuredServicePersistence";

import { resolveFinalIntentFromTurn } from "./resolveFinalIntentFromTurn";
import { getCanonicalCatalogRouteDecision } from "./getCanonicalCatalogRouteDecision";
import { resolveBusinessInfoOverviewCanonicalBody } from "../businessInfo/resolveBusinessInfoOverviewCanonicalBody";
import { resolveBusinessInfoFacetsCanonicalBody } from "../businessInfo/resolveBusinessInfoFacetsCanonicalBody";
import type { CatalogReferenceClassification } from "../../../catalog/types";

const MAX_WHATSAPP_LINES = 9999;

type PendingCtaLike = {
  type?: string | null;
  awaitsConfirmation?: boolean | null;
};

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
};

type FastpathSemanticTurn = {
  domain: "catalog" | "business_info" | "booking" | "other";
  scope: "overview" | "family" | "service" | "variant" | "none";
  answerKind:
    | "price"
    | "includes"
    | "schedule"
    | "location"
    | "availability"
    | "comparison"
    | "overview"
    | "other";
  resolution: "resolved" | "ambiguous" | "unresolved" | "overview";
  grounded: boolean;
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

function getPendingCtaFromCtx(convoCtx: any): PendingCtaLike | null {
  if (!convoCtx || typeof convoCtx !== "object") return null;

  const directPendingCta =
    convoCtx.pendingCta ??
    convoCtx.pending_cta ??
    convoCtx.replyPolicy?.pendingCta ??
    convoCtx.reply_policy?.pendingCta ??
    null;

  if (!directPendingCta || typeof directPendingCta !== "object") {
    return null;
  }

  return {
    type:
      typeof directPendingCta.type === "string"
        ? directPendingCta.type
        : null,
    awaitsConfirmation: directPendingCta.awaitsConfirmation === true,
  };
}

function hasExplicitPendingCtaAwaitingConfirmation(convoCtx: any): boolean {
  const pendingCta = getPendingCtaFromCtx(convoCtx);

  return Boolean(
    pendingCta &&
      pendingCta.type &&
      pendingCta.awaitsConfirmation === true
  );
}

function buildFastpathSemanticTurn(input: {
  detectedIntent?: string | null;
  detectedFacets?: IntentFacets | null;
  detectedRoutingHints?: IntentRoutingHints | null;
  structuredService: {
    hasResolution: boolean;
  };
  fp: {
    source?: string | null;
  };
  catalogReferenceClassification?: CatalogReferenceClassification | null;
}): FastpathSemanticTurn {
  const normalizedIntent = String(input.detectedIntent || "")
    .trim()
    .toLowerCase();

  const classificationKind = String(
    input.catalogReferenceClassification?.kind || ""
  )
    .trim()
    .toLowerCase();

  const catalogScope = input.detectedRoutingHints?.catalogScope || "none";
  const businessInfoScope =
    input.detectedRoutingHints?.businessInfoScope || "none";

  const asksPrices = input.detectedFacets?.asksPrices === true;
  const asksSchedules = input.detectedFacets?.asksSchedules === true;
  const asksLocation = input.detectedFacets?.asksLocation === true;
  const asksAvailability = input.detectedFacets?.asksAvailability === true;

  const hasCatalogResolution = input.structuredService?.hasResolution === true;
  const asksDisambiguation =
    input.catalogReferenceClassification?.shouldAskDisambiguation === true;

  const grounded =
    hasCatalogResolution ||
    classificationKind === "entity_specific" ||
    classificationKind === "variant_specific" ||
    String(input.fp?.source || "").trim().toLowerCase() === "catalog_db";

  const scope: FastpathSemanticTurn["scope"] =
    classificationKind === "variant_specific"
      ? "variant"
      : classificationKind === "entity_specific"
      ? "service"
      : classificationKind === "catalog_family"
      ? "family"
      : catalogScope === "overview" || businessInfoScope === "overview"
      ? "overview"
      : "none";

  const answerKind: FastpathSemanticTurn["answerKind"] =
    classificationKind === "comparison"
      ? "comparison"
      : normalizedIntent === "info_servicio"
      ? "includes"
      : asksPrices
      ? "price"
      : asksSchedules
      ? "schedule"
      : asksLocation
      ? "location"
      : asksAvailability
      ? "availability"
      : normalizedIntent === "info_general"
      ? "overview"
      : "other";

  const domain: FastpathSemanticTurn["domain"] =
    catalogScope !== "none" ||
    scope === "service" ||
    scope === "family" ||
    scope === "variant"
      ? "catalog"
      : businessInfoScope !== "none"
      ? "business_info"
      : "other";

  const resolution: FastpathSemanticTurn["resolution"] =
    asksDisambiguation
      ? "ambiguous"
      : hasCatalogResolution
      ? "resolved"
      : scope === "overview"
      ? "overview"
      : "unresolved";

  return {
    domain,
    scope,
    answerKind,
    resolution,
    grounded,
  };
}

function decideHybridDomain(input: {
  hasPendingCatalogChoice: boolean;
  isMixedScheduleAndPriceTurn: boolean;
  isGuidedBusinessEntryTurn: boolean;
  detectedFacets?: IntentFacets | null;
  detectedRoutingHints?: IntentRoutingHints | null;
  canonicalCatalogRouteDecision: {
    resolutionKind?: string | null;
  };
  catalogReferenceClassification: CatalogReferenceClassification;
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
    input.detectedRoutingHints?.catalogScope === "overview" &&
    input.detectedFacets?.asksPrices === true
  ) {
    return {
      routeTarget: "catalog",
      reason: "catalog_overview_signal",
    };
  }

  if (input.detectedRoutingHints?.businessInfoScope !== "none") {
    return {
      routeTarget: "business_info",
      reason: "business_info_signal",
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

export async function handleFastpathHybridTurn(
  args: FastpathHybridArgs
): Promise<FastpathHybridResult> {
  const {
    pool,
    tenantId,
    canal,
    idiomaDestino,
    userInput,
    inBooking,
    convoCtx,
    infoClave,
    detectedIntent,
    detectedFacets,
    detectedCommercial,
    detectedRoutingHints,
    intentFallback,
    messageId,
    contactoNorm,
    promptBaseMem,
    referentialFollowup,
    followupNeedsAnchor,
    followupEntityKind,
  } = args;

  const pendingCta = getPendingCtaFromCtx(convoCtx);

  const hasPendingCatalogChoice =
    Boolean(convoCtx?.pendingCatalogChoice) &&
    (
      convoCtx?.pendingCatalogChoice?.kind === "service_choice" ||
      convoCtx?.pendingCatalogChoice?.kind === "variant_choice"
    );

  if (
    hasExplicitPendingCtaAwaitingConfirmation(convoCtx) &&
    process.env.DEBUG_FASTPATH === "true"
  ) {
    console.log("[FASTPATH_HYBRID][PENDING_CTA_STATE_DETECTED]", {
      tenantId,
      canal,
      contactoNorm,
      userInput,
      pendingCta,
    });
  }

  const currentIntent = detectedIntent || intentFallback || null;
  const normalizedCurrentIntent = String(currentIntent || "").trim().toLowerCase();

  const asksSchedules = detectedFacets?.asksSchedules === true;
  const asksPrices = detectedFacets?.asksPrices === true;

  const isMixedScheduleAndPriceTurn = asksSchedules && asksPrices;

  const isGuidedBusinessEntryTurn =
    !asksSchedules &&
    !asksPrices &&
    !detectedCommercial?.wantsBooking &&
    !detectedCommercial?.wantsQuote &&
    !detectedCommercial?.wantsHuman &&
    (
      normalizedCurrentIntent === "duda" ||
      normalizedCurrentIntent === "info_general" ||
      normalizedCurrentIntent === ""
    );

  const previewClassificationInput = buildCatalogReferenceClassificationInput({
    userText: userInput,
    convoCtx,
    detectedIntent: null,
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

  let { explicitEntityCandidateForClassification, structuredComparison } =
    await getFastpathCatalogSignals({
      pool,
      tenantId,
      userInput,
      convoCtx,
      previewClassification,
      previewPolicy,
    });

  const catalogReferenceIntent = previewPolicy.shouldRouteCatalog
    ? normalizedCurrentIntent || null
    : null;

  console.log("[TRACE_CATALOG][PRE_BUILD_INPUT]", {
    userInput,
    catalogReferenceIntent,
    explicitEntityCandidateForClassification:
      explicitEntityCandidateForClassification ?? null,
    structuredComparison: structuredComparison ?? null,
  });

  const catalogReferenceClassificationInput =
    buildCatalogReferenceClassificationInput({
      userText: userInput,
      convoCtx,
      detectedIntent: catalogReferenceIntent,
      explicitEntityCandidate: explicitEntityCandidateForClassification,
      explicitVariantCandidate: null,
      explicitFamilyCandidate: null,
      structuredComparison,
    });

  if (structuredComparison?.hasComparison) {
    explicitEntityCandidateForClassification = null;
  }

  const preliminaryClassification = classifyCatalogReferenceTurn({
    ...catalogReferenceClassificationInput,
    explicitEntityCandidate: explicitEntityCandidateForClassification,
    structuredComparison,
    detectedIntent: catalogReferenceIntent,
  });

  const routingPolicy = buildFastpathTurnPolicy({
    classification: preliminaryClassification,
    facets: detectedFacets || null,
    structuredComparison,
    convoCtx,
    referentialFollowup,
    followupNeedsAnchor,
  });

  const catalogReferenceClassification = routingPolicy.shouldRouteCatalog
    ? preliminaryClassification
    : classifyCatalogReferenceTurn({
        ...catalogReferenceClassificationInput,
        explicitEntityCandidate: explicitEntityCandidateForClassification,
        structuredComparison,
        detectedIntent: null,
      });

  console.log("[CATALOG_REFERENCE_CLASSIFIER]", {
    tenantId,
    canal,
    contactoNorm,
    userInput,
    detectedIntent,
    intentFallback,
    explicitEntityCandidateForClassification,
    classificationInput: catalogReferenceClassificationInput,
    classification: catalogReferenceClassification,
  });

  const rawCatalogRoutingSignal = buildCatalogRoutingSignal({
    intentOut: detectedIntent || intentFallback || null,
    catalogReferenceClassification,
    convoCtx,
    facets: detectedFacets || null,
  });

  const catalogRoutingSignal = {
    ...rawCatalogRoutingSignal,
    hasFreshCatalogContext:
      Boolean(rawCatalogRoutingSignal?.hasFreshCatalogContext) &&
      routingPolicy.canReuseCatalogContext,
    previousCatalogPlans:
      Boolean(rawCatalogRoutingSignal?.hasFreshCatalogContext) &&
      routingPolicy.canReuseCatalogContext
        ? Array.isArray(rawCatalogRoutingSignal?.previousCatalogPlans)
          ? rawCatalogRoutingSignal.previousCatalogPlans
          : []
        : [],
  };

  const rawCanonicalCatalogRouteDecision =
    await getCanonicalCatalogRouteDecision({
      pool,
      tenantId,
      userInput,
    });

  const canonicalCatalogRouteDecision = isMixedScheduleAndPriceTurn
    ? {
        shouldRouteCatalog: true,
        resolutionKind: "none" as const,
        resolution: {
          kind: "none" as const,
          hit: null,
          candidates: [],
        },
      }
    : rawCanonicalCatalogRouteDecision;

  const domainDecision = decideHybridDomain({
    hasPendingCatalogChoice,
    isMixedScheduleAndPriceTurn,
    isGuidedBusinessEntryTurn,
    detectedFacets: detectedFacets || null,
    detectedRoutingHints: detectedRoutingHints || null,
    canonicalCatalogRouteDecision,
    catalogReferenceClassification,
  });

  const routeTarget = domainDecision.routeTarget;

  if (routeTarget === "business_info") {
    const wantsBusinessOverview =
      detectedRoutingHints?.businessInfoScope === "overview" ||
      normalizedCurrentIntent === "info_general";

    const wantsBusinessFacets =
      detectedFacets?.asksSchedules === true ||
      detectedFacets?.asksLocation === true ||
      detectedFacets?.asksAvailability === true;

    let canonicalBusinessReply = "";

    if (wantsBusinessOverview) {
      canonicalBusinessReply =
        await resolveBusinessInfoOverviewCanonicalBody({
          tenantId,
          canal,
          idiomaDestino,
          userInput,
          promptBaseMem,
          infoClave,
          overviewMode: isGuidedBusinessEntryTurn
            ? "guided_entry"
            : "general_overview",
        });
    } else if (wantsBusinessFacets) {
      canonicalBusinessReply =
        await resolveBusinessInfoFacetsCanonicalBody({
          tenantId,
          canal,
          idiomaDestino,
          userInput,
          promptBaseMem,
          infoClave,
          facets: {
            asksSchedules: detectedFacets?.asksSchedules === true,
            asksLocation: detectedFacets?.asksLocation === true,
            asksAvailability: detectedFacets?.asksAvailability === true,
          },
        });
    }

    canonicalBusinessReply = String(canonicalBusinessReply || "").trim();

    console.log("[FASTPATH_HYBRID][BUSINESS_INFO_ROUTE]", {
      tenantId,
      canal,
      contactoNorm,
      userInput,
      detectedIntent,
      intentFallback,
      routeTarget,
      reason: domainDecision.reason,
      wantsBusinessOverview,
      wantsBusinessFacets,
      hasReply: Boolean(canonicalBusinessReply),
    });

    if (!canonicalBusinessReply) {
      return {
        handled: false,
        routeTarget: "business_info",
        intent: detectedIntent || intentFallback || null,
      };
    }

    let businessIntent: string | null = "info_general";

    if (!wantsBusinessOverview) {
      const activeFacetCount = [
        detectedFacets?.asksSchedules === true,
        detectedFacets?.asksLocation === true,
        detectedFacets?.asksAvailability === true,
      ].filter(Boolean).length;

      businessIntent =
        activeFacetCount === 1 && detectedFacets?.asksSchedules === true
          ? "horario"
          : activeFacetCount === 1 && detectedFacets?.asksLocation === true
          ? "ubicacion"
          : activeFacetCount === 1 && detectedFacets?.asksAvailability === true
          ? "disponibilidad"
          : "info_general";
    }

    let ctxPatch: any = {
      last_catalog_at: Date.now(),
      lastResolvedIntent: wantsBusinessOverview
        ? "info_general_overview"
        : "business_info_facets",
      pendingCatalogChoice: null,
      pendingCatalogChoiceAt: null,
    };

    if (detectedCommercial) {
      ctxPatch.commercialSignal = {
        purchaseIntent: detectedCommercial.purchaseIntent,
        wantsBooking: detectedCommercial.wantsBooking,
        wantsQuote: detectedCommercial.wantsQuote,
        wantsHuman: detectedCommercial.wantsHuman,
        urgency: detectedCommercial.urgency,
      };
    }

    if (pendingCta?.type) {
      ctxPatch.pendingCta = {
        type: pendingCta.type,
        awaitsConfirmation: pendingCta.awaitsConfirmation === true,
      };
    }

    const businessInfoFp = {
      handled: true as const,
      reply: canonicalBusinessReply,
      source: wantsBusinessOverview
        ? "info_general_overview_db"
        : "info_clave_db",
      intent: businessIntent,
      catalogPayload: {
        kind: "resolved_catalog_answer" as const,
        scope: "overview" as const,
        canonicalBlocks: {
          servicesBlock: wantsBusinessOverview ? canonicalBusinessReply : null,
          scheduleBlock:
            !wantsBusinessOverview && detectedFacets?.asksSchedules === true
              ? canonicalBusinessReply
              : null,
          locationBlock:
            !wantsBusinessOverview && detectedFacets?.asksLocation === true
              ? canonicalBusinessReply
              : null,
          availabilityBlock:
            !wantsBusinessOverview && detectedFacets?.asksAvailability === true
              ? canonicalBusinessReply
              : null,
        },
      },
    };

    const structuredService = {
      hasResolution: false,
    };

    const replyPolicy = buildFastpathReplyPolicy({
      canal,
      fp: businessInfoFp as any,
      detectedIntent: businessIntent,
      intentFallback: businessIntent,
      detectedCommercial,
      catalogRoutingSignal,
      catalogReferenceClassification,
      structuredService: structuredService as any,
      ctxPatch,
    });

    let finalReply = canonicalBusinessReply;

    const isDmChannel =
      canal === "whatsapp" ||
      canal === "facebook" ||
      canal === "instagram";

    if (isDmChannel) {
      const rendered = await renderFastpathDmReply({
        tenantId,
        canal,
        idiomaDestino,
        userInput,
        contactoNorm,
        messageId,
        promptBaseMem,
        fastpathText: finalReply,
        fp: businessInfoFp as any,
        detectedIntent: businessIntent,
        intentFallback: businessIntent,
        structuredService: structuredService as any,
        replyPolicy,
        ctxPatch,
        maxLines: MAX_WHATSAPP_LINES,
      });

      finalReply = String(rendered.reply || "").trim();
      ctxPatch = rendered.ctxPatch;
    }

    return {
      handled: true,
      routeTarget: "business_info",
      reply: finalReply,
      replySource: wantsBusinessOverview
        ? "info_general_overview_db"
        : "info_clave_db",
      intent: businessIntent,
      ctxPatch,
    };
  }

  if (routeTarget !== "catalog") {
    console.log("[FASTPATH_HYBRID][ROUTE_OUTSIDE_FASTPATH]", {
      tenantId,
      canal,
      contactoNorm,
      userInput,
      detectedIntent,
      intentFallback,
      routeTarget,
      reason: domainDecision.reason,
      canonicalCatalogRouteDecision,
      hasPendingCatalogChoice,
    });

    return {
      handled: false,
      routeTarget,
      intent: detectedIntent || intentFallback || null,
    };
  }

  const hasCanonicalCatalogResolution =
    canonicalCatalogRouteDecision.resolutionKind === "resolved_single" ||
    canonicalCatalogRouteDecision.resolutionKind ===
      "resolved_service_variant_ambiguous" ||
    canonicalCatalogRouteDecision.resolutionKind === "ambiguous";

  const effectiveCatalogReferenceClassification: CatalogReferenceClassification = {
    ...catalogReferenceClassification,
    kind:
      canonicalCatalogRouteDecision.resolutionKind === "resolved_single"
        ? "entity_specific"
        : canonicalCatalogRouteDecision.resolutionKind ===
          "resolved_service_variant_ambiguous"
        ? "entity_specific"
        : canonicalCatalogRouteDecision.resolutionKind === "ambiguous"
        ? "catalog_family"
        : catalogReferenceClassification.kind,
    shouldResolveEntity:
      canonicalCatalogRouteDecision.resolutionKind === "resolved_single" ||
      canonicalCatalogRouteDecision.resolutionKind ===
        "resolved_service_variant_ambiguous"
        ? true
        : catalogReferenceClassification.shouldResolveEntity,
    shouldAskDisambiguation:
      canonicalCatalogRouteDecision.resolutionKind ===
        "resolved_service_variant_ambiguous" ||
      canonicalCatalogRouteDecision.resolutionKind === "ambiguous"
        ? true
        : catalogReferenceClassification.shouldAskDisambiguation,
    targetLevel:
      canonicalCatalogRouteDecision.resolutionKind === "resolved_single"
        ? "service"
        : canonicalCatalogRouteDecision.resolutionKind ===
          "resolved_service_variant_ambiguous"
        ? "service"
        : canonicalCatalogRouteDecision.resolutionKind === "ambiguous"
        ? "multi_service"
        : catalogReferenceClassification.targetLevel,
    targetServiceId:
      canonicalCatalogRouteDecision.resolutionKind === "resolved_single" ||
      canonicalCatalogRouteDecision.resolutionKind ===
        "resolved_service_variant_ambiguous"
        ? canonicalCatalogRouteDecision.resolvedServiceId
        : catalogReferenceClassification.targetServiceId,
    targetServiceName:
      canonicalCatalogRouteDecision.resolutionKind === "resolved_single" ||
      canonicalCatalogRouteDecision.resolutionKind ===
        "resolved_service_variant_ambiguous"
        ? canonicalCatalogRouteDecision.resolvedServiceName
        : catalogReferenceClassification.targetServiceName,
    targetVariantId: null,
    targetVariantName: null,
    targetFamilyKey:
      canonicalCatalogRouteDecision.resolutionKind === "ambiguous"
        ? "canonical_ambiguous_family"
        : catalogReferenceClassification.targetFamilyKey,
    targetFamilyName:
      canonicalCatalogRouteDecision.resolutionKind === "ambiguous"
        ? "canonical_ambiguous_family"
        : catalogReferenceClassification.targetFamilyName,
  };

  const effectiveCatalogRoutingSignal = {
    ...catalogRoutingSignal,
    shouldRouteCatalog: true,
    allowsDbCatalogPath: true,
    referenceKind:
      canonicalCatalogRouteDecision.resolutionKind === "resolved_single"
        ? "entity_specific"
        : canonicalCatalogRouteDecision.resolutionKind ===
          "resolved_service_variant_ambiguous"
        ? "entity_specific"
        : canonicalCatalogRouteDecision.resolutionKind === "ambiguous"
        ? "catalog_family"
        : catalogRoutingSignal.referenceKind,
    source: "canonical_catalog_resolution",
    targetServiceId:
      canonicalCatalogRouteDecision.resolutionKind === "resolved_single" ||
      canonicalCatalogRouteDecision.resolutionKind ===
        "resolved_service_variant_ambiguous"
        ? canonicalCatalogRouteDecision.resolvedServiceId
        : catalogRoutingSignal.targetServiceId,
    targetServiceName:
      canonicalCatalogRouteDecision.resolutionKind === "resolved_single" ||
      canonicalCatalogRouteDecision.resolutionKind ===
        "resolved_service_variant_ambiguous"
        ? canonicalCatalogRouteDecision.resolvedServiceName
        : catalogRoutingSignal.targetServiceName,
    targetVariantId: null,
    targetVariantName: null,
    targetFamilyKey:
      canonicalCatalogRouteDecision.resolutionKind === "ambiguous"
        ? "canonical_ambiguous_family"
        : catalogRoutingSignal.targetFamilyKey,
    targetFamilyName:
      canonicalCatalogRouteDecision.resolutionKind === "ambiguous"
        ? "canonical_ambiguous_family"
        : catalogRoutingSignal.targetFamilyName,
    targetLevel:
      canonicalCatalogRouteDecision.resolutionKind === "resolved_single"
        ? "service"
        : canonicalCatalogRouteDecision.resolutionKind ===
          "resolved_service_variant_ambiguous"
        ? "service"
        : canonicalCatalogRouteDecision.resolutionKind === "ambiguous"
        ? "family"
        : catalogRoutingSignal.targetLevel,
    disambiguationType:
      canonicalCatalogRouteDecision.resolutionKind ===
        "resolved_service_variant_ambiguous"
        ? "variant_choice"
        : canonicalCatalogRouteDecision.resolutionKind === "ambiguous"
        ? "service_choice"
        : "none",
    anchorShift: "none",
  };

  const fpIntent = detectedIntent || intentFallback || null;

  const { convoCtxForFastpath, preResolvedCtxPatch, forcedAnchorCtxPatch } =
    await getPreResolvedCatalogService({
      pool,
      tenantId,
      userInput,
      convoCtx,
      catalogReferenceClassification: effectiveCatalogReferenceClassification,
      routingPolicy: hasCanonicalCatalogResolution
        ? {
            ...routingPolicy,
            shouldRouteCatalog: true,
          }
        : routingPolicy,
      referentialFollowup,
      followupNeedsAnchor,
      followupEntityKind,
    });

  const fp = await runFastpath({
    pool,
    tenantId,
    canal,
    idiomaDestino,
    userInput,
    inBooking,
    convoCtx: convoCtxForFastpath as any,
    infoClave,
    promptBase: promptBaseMem,
    detectedIntent: fpIntent,
    detectedFacets: detectedFacets || {},
    catalogReferenceClassification: effectiveCatalogReferenceClassification,
    maxDisambiguationOptions: 10,
    lastServiceTtlMs: 60 * 60 * 1000,
  });

  if (!fp.handled) {
    const unhandledCtxPatch = {
      ...(forcedAnchorCtxPatch || {}),
      ...(preResolvedCtxPatch || {}),
    };

    const shouldFallbackToBusinessInfo =
      !hasCanonicalCatalogResolution &&
      effectiveCatalogReferenceClassification.shouldResolveEntity !== true &&
      effectiveCatalogReferenceClassification.shouldAskDisambiguation !== true &&
      !effectiveCatalogRoutingSignal.targetServiceId &&
      !effectiveCatalogRoutingSignal.targetVariantId;

    return {
      handled: false,
      routeTarget: shouldFallbackToBusinessInfo
        ? "business_info"
        : "continue_pipeline",
      ctxPatch: Object.keys(unhandledCtxPatch).length
        ? unhandledCtxPatch
        : undefined,
      intent: detectedIntent || intentFallback || null,
    };
  }

  let ctxPatch: any = {
    ...(forcedAnchorCtxPatch || {}),
    ...(preResolvedCtxPatch || {}),
    ...(fp.ctxPatch ? { ...fp.ctxPatch } : {}),
  };

  if (detectedCommercial) {
    ctxPatch.commercialSignal = {
      purchaseIntent: detectedCommercial.purchaseIntent,
      wantsBooking: detectedCommercial.wantsBooking,
      wantsQuote: detectedCommercial.wantsQuote,
      wantsHuman: detectedCommercial.wantsHuman,
      urgency: detectedCommercial.urgency,
    };
  }

  if (pendingCta?.type) {
    ctxPatch.pendingCta = {
      type: pendingCta.type,
      awaitsConfirmation: pendingCta.awaitsConfirmation === true,
    };
  }

  const structuredService = getStructuredServiceForFastpath({
    fp,
    catalogRoutingSignal: effectiveCatalogRoutingSignal,
    catalogReferenceClassification: effectiveCatalogReferenceClassification,
    ctxPatch,
    convoCtxForFastpath,
  });

  const replyPolicy = buildFastpathReplyPolicy({
    canal,
    fp,
    detectedIntent,
    intentFallback,
    detectedCommercial,
    catalogRoutingSignal: effectiveCatalogRoutingSignal,
    catalogReferenceClassification: effectiveCatalogReferenceClassification,
    structuredService,
    ctxPatch,
  });

  const immediateReturn = getFastpathImmediateReturn({
    fp,
    detectedIntent,
    intentFallback,
    replyPolicy,
    catalogReferenceClassification: effectiveCatalogReferenceClassification,
  });

  const resolvedFinalIntent = resolveFinalIntentFromTurn({
    detectedIntent,
    intentFallback,
    fp: {
      intent: fp.intent ?? null,
      source: fp.source ?? null,
      catalogPayload: fp.handled ? fp.catalogPayload ?? null : null,
    },
    facets: detectedFacets || null,
    catalogRoutingSignal: effectiveCatalogRoutingSignal,
    catalogReferenceClassification: effectiveCatalogReferenceClassification,
  });

  const semanticTurn = buildFastpathSemanticTurn({
    detectedIntent: resolvedFinalIntent,
    detectedFacets: detectedFacets || null,
    detectedRoutingHints: detectedRoutingHints || null,
    structuredService,
    fp,
    catalogReferenceClassification: effectiveCatalogReferenceClassification,
  });

  const postRunDecision = getFastpathPostRunDecision({
    canal,
    fp,
    semanticTurn,
    convoCtx,
    structuredService,
  });

  console.log("[STRUCTURED_SERVICE][CALLER]", structuredService);

  ctxPatch = applyStructuredServicePersistence({
    shouldPersistStructuredService: replyPolicy.shouldPersistStructuredService,
    structuredService,
    ctxPatch,
  });

  if (fp.awaitingEffect?.type === "set_awaiting_yes_no") {
    const { setAwaitingState } = await import("../../../awaiting/setAwaitingState");
    await setAwaitingState(pool, {
      tenantId,
      canal,
      senderId: contactoNorm,
      field: "yes_no",
      payload: fp.awaitingEffect.payload,
      ttlSeconds: fp.awaitingEffect.ttlSeconds,
    });
  }

  let finalReply = String(fp.reply || "").trim();
  let finalReplySource: string | undefined = fp.source;
  let finalIntent: string | null = resolvedFinalIntent;

  if (immediateReturn.shouldReturnImmediately) {
    finalReply = String(immediateReturn.reply || "").trim();
    finalReplySource = immediateReturn.replySource || fp.source;
    finalIntent = immediateReturn.intent || resolvedFinalIntent;
  }

  if (postRunDecision.shouldNaturalizeSecondaryOptions) {
    finalReply = await naturalizeSecondaryOptionsLine({
      tenantId,
      idiomaDestino,
      canal,
      baseText: finalReply,
      primary: "plans",
      secondaryAvailable: true,
      maxLines: MAX_WHATSAPP_LINES,
    });
  }

  if (postRunDecision.isDmChannel) {
    const rendered = await renderFastpathDmReply({
      tenantId,
      canal,
      idiomaDestino,
      userInput,
      contactoNorm,
      messageId,
      promptBaseMem,
      fastpathText: finalReply,
      fp: {
        ...fp,
        reply: finalReply,
        source: finalReplySource,
        intent: finalIntent,
        catalogPayload: fp.catalogPayload,
      },
      detectedIntent: finalIntent,
      intentFallback: finalIntent,
      structuredService,
      replyPolicy,
      ctxPatch,
      maxLines: MAX_WHATSAPP_LINES,
    });

    finalReply = String(rendered.reply || "").trim();
    ctxPatch = rendered.ctxPatch;
  }

  console.log("[FASTPATH_HYBRID][FINAL_CTX_PATCH_KEYS]", {
    tenantId,
    canal,
    userInput,
    finalIntent,
    finalReplySource,
    ctxPatchKeys: ctxPatch ? Object.keys(ctxPatch) : [],
    pendingCatalogChoice: ctxPatch?.pendingCatalogChoice ?? null,
    pendingCatalogChoiceAt: ctxPatch?.pendingCatalogChoiceAt ?? null,
    lastResolvedIntent: ctxPatch?.lastResolvedIntent ?? null,
    selectedServiceId: ctxPatch?.selectedServiceId ?? null,
    last_service_id: ctxPatch?.last_service_id ?? null,
    last_service_name: ctxPatch?.last_service_name ?? null,
  });

  return {
    handled: true,
    routeTarget: "catalog",
    reply: finalReply,
    replySource: finalReplySource,
    intent: finalIntent,
    ctxPatch,
  };
}