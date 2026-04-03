//src/lib/channels/engine/fastpath/handleFastpathHybridTurn.ts
import { Pool } from "pg";
import type {
  Canal,
  CommercialSignal,
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

const MAX_WHATSAPP_LINES = 9999;

type PendingCtaLike = {
  type?: string | null;
  awaitsConfirmation?: boolean | null;
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
  intentFallback: string | null;
  messageId: string | null;
  contactoNorm: string;
  promptBaseMem: string;
  referentialFollowup?: boolean;
  followupNeedsAnchor?: boolean;
  followupEntityKind?: "service" | "plan" | "package" | null;
};

export type FastpathHybridRoute =
  | "catalog"
  | "business_info"
  | "continue_pipeline";

export type FastpathHybridResult = {
  handled: boolean;
  reply?: string;
  replySource?: string;
  intent?: string | null;
  ctxPatch?: any;
  routeTarget?: FastpathHybridRoute;
};

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
    intentFallback,
    messageId,
    contactoNorm,
    promptBaseMem,
    referentialFollowup,
    followupNeedsAnchor,
    followupEntityKind,
  } = args;

  const pendingCta = getPendingCtaFromCtx(convoCtx);

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

  const shouldHandleCatalogInFastpath =
    routingPolicy.shouldRouteCatalog === true ||
    catalogRoutingSignal.shouldRouteCatalog === true;

  const routeTarget: FastpathHybridRoute = shouldHandleCatalogInFastpath
    ? "catalog"
    : "business_info";

  if (routeTarget === "business_info") {
    console.log("[FASTPATH_HYBRID][ROUTE_BUSINESS_INFO_OUTSIDE_FASTPATH]", {
      tenantId,
      canal,
      contactoNorm,
      userInput,
      detectedIntent,
      intentFallback,
      routingPolicy,
      catalogRoutingSignal,
    });

    return {
      handled: false,
      routeTarget: "business_info",
      intent: detectedIntent || intentFallback || null,
    };
  }

  const fpIntent = detectedIntent || intentFallback || null;

  const { convoCtxForFastpath, preResolvedCtxPatch, forcedAnchorCtxPatch } =
    await getPreResolvedCatalogService({
      pool,
      tenantId,
      userInput,
      convoCtx,
      catalogReferenceClassification,
      routingPolicy,
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
    catalogReferenceClassification,
    maxDisambiguationOptions: 10,
    lastServiceTtlMs: 60 * 60 * 1000,
  });

  if (!fp.handled) {
    const unhandledCtxPatch = {
      ...(forcedAnchorCtxPatch || {}),
      ...(preResolvedCtxPatch || {}),
    };

    return {
      handled: false,
      routeTarget: "continue_pipeline",
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
    catalogRoutingSignal,
    catalogReferenceClassification,
    ctxPatch,
    convoCtxForFastpath,
  });

  const replyPolicy = buildFastpathReplyPolicy({
    canal,
    fp,
    detectedIntent,
    intentFallback,
    detectedCommercial,
    catalogRoutingSignal,
    catalogReferenceClassification,
    structuredService,
    ctxPatch,
  });

  const immediateReturn = getFastpathImmediateReturn({
    fp,
    detectedIntent,
    intentFallback,
    replyPolicy,
    catalogReferenceClassification,
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
    catalogRoutingSignal,
    catalogReferenceClassification,
  });

  const postRunDecision = getFastpathPostRunDecision({
    canal,
    fp,
    detectedIntent: resolvedFinalIntent,
    intentFallback: resolvedFinalIntent,
    convoCtx,
    catalogRoutingSignal,
    catalogReferenceClassification,
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