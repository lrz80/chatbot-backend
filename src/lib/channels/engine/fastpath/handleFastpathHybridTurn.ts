import { Pool } from "pg";
import type { Canal } from "../../../detectarIntencion";
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

const MAX_WHATSAPP_LINES = 9999;

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
    intentFallback,
    messageId,
    contactoNorm,
    promptBaseMem,
    referentialFollowup,
    followupNeedsAnchor,
    followupEntityKind,
  } = args;

  const currentIntent = (detectedIntent || intentFallback || null) ?? null;
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

  let {
    explicitEntityCandidateForClassification,
    structuredComparison,
    entityCandidateResultLoose,
  } = await getFastpathCatalogSignals({
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

  console.log("[TRACE_CATALOG][POST_BUILD_INPUT]", {
    catalogReferenceClassificationInput,
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

  const fpIntent = catalogRoutingSignal.shouldRouteCatalog
    ? detectedIntent || intentFallback || "precio"
    : detectedIntent || intentFallback || null;

  const {
    convoCtxForFastpath,
    preResolvedCtxPatch,
    forcedAnchorCtxPatch,
    explicitServiceResolved,
    explicitResolvedServiceId,
    explicitResolvedServiceName,
  } = await getPreResolvedCatalogService({
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

  if (process.env.DEBUG_FASTPATH === "true") {
    console.log("[FASTPATH_HYBRID][ENTRY_AFTER_RUN]", {
      tenantId,
      canal,
      userInput,
      fpHandled: fp.handled,
      fpSource: fp.handled ? fp.source : null,
      fpIntent: fp.handled ? fp.intent : null,
      fpReplyPreview: fp.handled ? String(fp.reply || "").slice(0, 200) : null,
      fpCtxPatchKeys: fp.handled && fp.ctxPatch ? Object.keys(fp.ctxPatch) : [],
    });
  }

  if (!fp.handled) {
    const unhandledCtxPatch = {
      ...(forcedAnchorCtxPatch || {}),
      ...(preResolvedCtxPatch || {}),
    };

    if (process.env.DEBUG_FASTPATH === "true") {
      console.log("[FASTPATH_HYBRID][RETURN_UNHANDLED_WITH_CTX]", {
        tenantId,
        canal,
        userInput,
        forcedAnchorCtxPatch,
        preResolvedCtxPatch,
        unhandledCtxPatch,
      });
    }

    return {
      handled: false,
      ctxPatch: Object.keys(unhandledCtxPatch).length
        ? unhandledCtxPatch
        : undefined,
      intent: detectedIntent || intentFallback || null,
    };
  }

  const ctxPatch: any = fp.ctxPatch ? { ...fp.ctxPatch } : {};

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

  const postRunDecision = getFastpathPostRunDecision({
    canal,
    fp,
    detectedIntent,
    intentFallback,
    convoCtx,
    catalogRoutingSignal,
    catalogReferenceClassification,
    structuredService,
  });

  const shouldBypassStructuredRewrite =
    replyPolicy.shouldBypassStructuredRewrite;

  if (shouldBypassStructuredRewrite) {
    return {
      handled: true,
      reply: fp.reply,
      replySource: fp.source,
      intent: fp.intent || detectedIntent || intentFallback || null,
      ctxPatch,
    };
  }

  console.log("[STRUCTURED_SERVICE][CALLER]", structuredService);

  const shouldPersistStructuredService =
    replyPolicy.shouldPersistStructuredService;

  if (shouldPersistStructuredService && structuredService.serviceId) {
    ctxPatch.last_service_id = structuredService.serviceId;
    ctxPatch.selectedServiceId = structuredService.serviceId;
  }

  if (shouldPersistStructuredService && structuredService.serviceName) {
    ctxPatch.last_service_name = structuredService.serviceName;
    ctxPatch.selectedServiceName = structuredService.serviceName;
  }

  if (shouldPersistStructuredService && structuredService.serviceLabel) {
    ctxPatch.last_service_label = structuredService.serviceLabel;
    ctxPatch.selectedServiceLabel = structuredService.serviceLabel;
  }

  if (shouldPersistStructuredService) {
    ctxPatch.last_entity_kind = "service";
    ctxPatch.last_entity_at = Date.now();
  }

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

  let fastpathText = String(fp.reply || "");

  if (immediateReturn.shouldReturnImmediately) {
    return {
      handled: true,
      reply: immediateReturn.reply,
      replySource: immediateReturn.replySource,
      intent: immediateReturn.intent,
      ctxPatch,
    };
  }

  if (postRunDecision.shouldReturnRawFastpathForPriceQuestion) {
    return {
      handled: true,
      reply: fastpathText,
      replySource: fp.source,
      intent: fp.intent || detectedIntent || intentFallback || null,
      ctxPatch,
    };
  }

  if (postRunDecision.shouldNaturalizeSecondaryOptions) {
    fastpathText = await naturalizeSecondaryOptionsLine({
      tenantId,
      idiomaDestino,
      canal,
      baseText: fastpathText,
      primary: "plans",
      secondaryAvailable: true,
      maxLines: MAX_WHATSAPP_LINES,
    });
  }

  if (postRunDecision.shouldReturnRawFastpathForUnresolvedServiceIntent) {
    return {
      handled: true,
      reply: fastpathText,
      replySource: fp.source,
      intent: fp.intent || detectedIntent || intentFallback || null,
      ctxPatch,
    };
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
      fastpathText,
      fp,
      detectedIntent,
      intentFallback,
      structuredService,
      replyPolicy,
      ctxPatch,
      maxLines: MAX_WHATSAPP_LINES,
    });

    return {
      handled: true,
      reply: rendered.reply,
      replySource: fp.source,
      intent: fp.intent || detectedIntent || intentFallback || null,
      ctxPatch: rendered.ctxPatch,
    };
  }

  console.log("[DM_CHANNEL_CHECK]", {
    canal,
    isDm: postRunDecision.isDmChannel,
  });

  return {
    handled: true,
    reply: fastpathText,
    replySource: fp.source,
    intent: fp.intent || detectedIntent || intentFallback || null,
    ctxPatch,
  };
}