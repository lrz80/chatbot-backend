// backend/src/lib/channels/engine/fastpath/handleFastpathHybridTurn.ts

import { Pool } from "pg";
import type { Canal } from "../../../detectarIntencion";
import type { Lang } from "../clients/clientDb";
import { runFastpath } from "../../../fastpath/runFastpath";
import { naturalizeSecondaryOptionsLine } from "../../../fastpath/naturalizeSecondaryOptions";
import { getRecentHistoryForModel } from "../messages/getRecentHistoryForModel";
import { answerWithPromptBase } from "../../../answers/answerWithPromptBase";
import { resolveServiceCandidatesFromText } from "../../../services/pricing/resolveServiceIdFromText";
import { stripMarkdownLinksForDm } from "../../format/stripMarkdownLinks";

import { buildCatalogReferenceClassificationInput } from "../../../catalog/buildCatalogReferenceClassificationInput";
import { classifyCatalogReferenceTurn } from "../../../catalog/classifyCatalogReferenceTurn";

import { buildCatalogRoutingSignal } from "../../../catalog/buildCatalogRoutingSignal";

const MAX_WHATSAPP_LINES = 9999; // mantenemos el mismo valor

type IntentFacets = {
  asksPrices?: boolean;
  asksSchedules?: boolean;
  asksLocation?: boolean;
  asksAvailability?: boolean;
};

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

function isDmChatChannel(canal: Canal) {
  const c = String(canal || "").toLowerCase();
  return c === "whatsapp" || c === "facebook" || c === "instagram";
}

function firstNonEmptyString(...values: any[]): string | null {
  for (const value of values) {
    const v = String(value ?? "").trim();
    if (v) return v;
  }
  return null;
}

function shouldUseRoutingStructuredService(signal: any): boolean {
  const targetLevel = String(signal?.targetLevel || "").trim().toLowerCase();
  const routeIntent = String(signal?.routeIntent || "").trim().toLowerCase();
  const referenceKind = String(signal?.referenceKind || "").trim().toLowerCase();

  const hasSpecificTargetLevel =
    targetLevel === "service" || targetLevel === "variant";

  const hasSpecificReferenceKind =
    referenceKind === "entity_specific" ||
    referenceKind === "variant_specific" ||
    referenceKind === "referential_followup";

  const hasServiceScopedRouteIntent =
    routeIntent === "catalog_price" ||
    routeIntent === "catalog_alternatives" ||
    routeIntent === "catalog_schedule" ||
    routeIntent === "catalog_includes";

  return (
    (hasSpecificTargetLevel || hasSpecificReferenceKind) &&
    hasServiceScopedRouteIntent
  );
}

function isBusinessInfoIntent(intent: string | null | undefined): boolean {
  const normalized = String(intent || "").trim().toLowerCase();

  return (
    normalized === "horario" ||
    normalized === "schedule" ||
    normalized === "ubicacion" ||
    normalized === "location" ||
    normalized === "disponibilidad" ||
    normalized === "availability" ||
    normalized === "info_horarios_generales"
  );
}

function toFiniteNumber(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function hasStrongStructuredEntityEvidence(params: {
  matchedCandidate: any;
  allCandidates: any[];
  classificationKind: string | null | undefined;
  convoCtx: any;
}): boolean {
  const { matchedCandidate, allCandidates, classificationKind, convoCtx } = params;

  if (!matchedCandidate) return false;

  const exactNameHits = toFiniteNumber(matchedCandidate?.exactNameHits);
  const exactVariantHits = toFiniteNumber(matchedCandidate?.exactVariantHits);
  const dominantOverlapCount = toFiniteNumber(
    matchedCandidate?.dominantOverlapCount
  );
  const bestScore = toFiniteNumber(matchedCandidate?.score);

  const sortedCandidates = Array.isArray(allCandidates)
    ? [...allCandidates]
        .map((candidate) => ({
          ...candidate,
          score: toFiniteNumber(candidate?.score),
        }))
        .sort((a, b) => b.score - a.score)
    : [];

  const secondScore =
    sortedCandidates.length > 1
      ? toFiniteNumber(sortedCandidates[1]?.score)
      : 0;

  const scoreGap = bestScore - secondScore;

  const hasAnchoredService =
    Boolean(convoCtx?.last_service_id) ||
    Boolean(convoCtx?.selectedServiceId) ||
    Boolean(convoCtx?.selected_service_id);

  const classificationSuggestsSpecificEntity =
    classificationKind === "entity_specific" ||
    classificationKind === "variant_specific";

  const hasVariantLevelEvidence = exactVariantHits >= 1;
  const hasStrongNameEvidence = exactNameHits >= 2;
  const hasStrongRankingLead = bestScore > 0 && scoreGap >= 0.35;
  const hasMeaningfulDominance = dominantOverlapCount >= 2;

  return (
    hasVariantLevelEvidence ||
    hasStrongNameEvidence ||
    (
      classificationSuggestsSpecificEntity &&
      (hasStrongRankingLead || hasMeaningfulDominance)
    ) ||
    (
      hasAnchoredService &&
      classificationSuggestsSpecificEntity &&
      bestScore > 0
    )
  );
}

function shouldPromoteExplicitEntityCandidate(params: {
  currentIntent: string | null | undefined;
  matchedCandidate: any;
  allCandidates: any[];
  classificationKind: string | null | undefined;
  convoCtx: any;
}): boolean {
  const {
    currentIntent,
    matchedCandidate,
    allCandidates,
    classificationKind,
    convoCtx,
  } = params;

  if (!matchedCandidate) return false;

  if (!isBusinessInfoIntent(currentIntent)) {
    return true;
  }

  return hasStrongStructuredEntityEvidence({
    matchedCandidate,
    allCandidates,
    classificationKind,
    convoCtx,
  });
}

function getStructuredServiceSelection(ctxPatch: any, convoCtx: any) {
  const serviceId = firstNonEmptyString(
    ctxPatch?.last_service_id,
    ctxPatch?.selectedServiceId,
    ctxPatch?.selected_service_id,
    ctxPatch?.serviceId,
    convoCtx?.last_service_id,
    convoCtx?.selectedServiceId,
    convoCtx?.selected_service_id,
    convoCtx?.serviceId
  );

  const serviceName = firstNonEmptyString(
    ctxPatch?.last_service_name,
    ctxPatch?.selectedServiceName,
    ctxPatch?.selected_service_name,
    ctxPatch?.serviceName,
    convoCtx?.last_service_name,
    convoCtx?.selectedServiceName,
    convoCtx?.selected_service_name,
    convoCtx?.serviceName
  );

  const serviceLabel = firstNonEmptyString(
    ctxPatch?.last_service_label,
    ctxPatch?.selectedServiceLabel,
    ctxPatch?.selected_service_label,
    ctxPatch?.serviceLabel,
    convoCtx?.last_service_label,
    convoCtx?.selectedServiceLabel,
    convoCtx?.selected_service_label,
    convoCtx?.serviceLabel,
    serviceName
  );

  return {
    serviceId,
    serviceName,
    serviceLabel,
    hasResolution: !!serviceId || !!serviceName || !!serviceLabel,
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
    intentFallback,
    messageId,
    contactoNorm,
    promptBaseMem,
    referentialFollowup,
    followupNeedsAnchor,
    followupEntityKind,
  } = args;

  const loweredInput = (userInput || "").toLowerCase();

  // Intención “final” de este turno (signals)
  const currentIntent = (detectedIntent || intentFallback || null) ?? null;

  const normalizedCurrentIntent = String(currentIntent || "").trim().toLowerCase();

  const CATALOG_ROUTING_INTENTS = new Set([
    "precio",
    "planes_precios",
    "info_horarios_generales",
    "schedule",
    "info_servicio",
  ]);

  const shouldRouteCatalog =
    CATALOG_ROUTING_INTENTS.has(normalizedCurrentIntent) ||
    referentialFollowup === true ||
    followupNeedsAnchor === true;

  let explicitEntityCandidateForClassification: {
    id: string;
    name: string;
    score: number;
  } | null = null;

  try {
    const entityCandidateResult = await resolveServiceCandidatesFromText(
      pool,
      tenantId,
      userInput,
      { mode: "loose" }
    );

    const resolvedHit = entityCandidateResult?.hit ?? null;
    const allCandidates = Array.isArray(entityCandidateResult?.candidates)
      ? entityCandidateResult.candidates
      : [];

    if (resolvedHit?.id) {
      const matchedCandidateRaw: any =
        allCandidates.find(
          (candidate: any) =>
            String(candidate?.id || "") === String(resolvedHit.id)
        ) || null;

      const previewClassificationInput =
        buildCatalogReferenceClassificationInput({
          userText: userInput,
          convoCtx,
          detectedIntent: shouldRouteCatalog ? normalizedCurrentIntent : null,
        });

      const previewClassification = classifyCatalogReferenceTurn({
        ...previewClassificationInput,
        explicitEntityCandidate: null,
        detectedIntent: shouldRouteCatalog ? normalizedCurrentIntent : null,
      });

      const canPromoteCandidate = shouldPromoteExplicitEntityCandidate({
        currentIntent: normalizedCurrentIntent,
        matchedCandidate: matchedCandidateRaw,
        allCandidates,
        classificationKind: previewClassification?.kind,
        convoCtx,
      });

      if (canPromoteCandidate) {
        explicitEntityCandidateForClassification = {
          id: String(resolvedHit.id),
          name: String(resolvedHit.name || "").trim(),
          score: toFiniteNumber(matchedCandidateRaw?.score || 1),
        };
      } else {
        console.log(
          "[CATALOG_REFERENCE_CLASSIFIER][ENTITY_CANDIDATE_SKIPPED_BY_STRUCTURE]",
          {
            tenantId,
            canal,
            contactoNorm,
            userInput,
            normalizedCurrentIntent,
            resolvedHitId: String(resolvedHit.id),
            resolvedHitName: String(resolvedHit.name || "").trim(),
            previewClassificationKind: previewClassification?.kind || null,
            matchedCandidate: matchedCandidateRaw
              ? {
                  score: toFiniteNumber(matchedCandidateRaw?.score),
                  exactNameHits: toFiniteNumber(matchedCandidateRaw?.exactNameHits),
                  exactVariantHits: toFiniteNumber(
                    matchedCandidateRaw?.exactVariantHits
                  ),
                  dominantOverlapCount: toFiniteNumber(
                    matchedCandidateRaw?.dominantOverlapCount
                  ),
                }
              : null,
          }
        );
      }
    }
  } catch (e: any) {
    console.warn(
      "[CATALOG_REFERENCE_CLASSIFIER][EXPLICIT_ENTITY_CANDIDATE] failed:",
      e?.message || e
    );
  }

  const catalogReferenceIntent =
  CATALOG_ROUTING_INTENTS.has(normalizedCurrentIntent)
    ? normalizedCurrentIntent
    : null;

  const catalogReferenceClassificationInput =
    buildCatalogReferenceClassificationInput({
      userText: userInput,
      convoCtx,
      detectedIntent: catalogReferenceIntent,
    });

  const catalogReferenceClassification = shouldRouteCatalog
    ? classifyCatalogReferenceTurn({
        ...catalogReferenceClassificationInput,
        explicitEntityCandidate: explicitEntityCandidateForClassification,
        detectedIntent: catalogReferenceIntent,
      })
    : classifyCatalogReferenceTurn({
        ...catalogReferenceClassificationInput,
        explicitEntityCandidate: explicitEntityCandidateForClassification,
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

  const catalogRoutingSignal = buildCatalogRoutingSignal({
    intentOut: detectedIntent || intentFallback || null,
    catalogReferenceClassification,
    convoCtx,
  });

  const isPriceQuestionUser =
    catalogRoutingSignal.routeIntent === "catalog_price" ||
    catalogRoutingSignal.routeIntent === "catalog_alternatives";

  const shouldForceCatalogRouting = catalogRoutingSignal.shouldRouteCatalog;

  const wantsPlansAndHours =
    catalogRoutingSignal.routeIntent === "catalog_schedule";

  const isMorePlansFollowup =
    catalogRoutingSignal.routeIntent === "catalog_alternatives";

  const isCatalogDetailQuestion =
    catalogRoutingSignal.routeIntent === "catalog_includes" ||
    catalogReferenceClassification.intent === "includes" ||
    normalizedCurrentIntent === "info_servicio";

  const fpIntent = shouldForceCatalogRouting
  ? (detectedIntent || intentFallback || "precio")
  : (detectedIntent || intentFallback || null);

  // ============================================
  // PRE-RESOLVE DE SERVICIO DESDE EL MENSAJE DEL USUARIO
  // Esto cubre el caso donde Fastpath no maneja el turno
  // pero el usuario sí mencionó un servicio de forma suficiente.
  // ============================================
  const preResolvedCtxPatch: any = {};

  // Solo intentamos pre-resolver entidad cuando el turno parece
  // realmente sobre un servicio concreto, no sobre catálogo general.
  const shouldTryPreResolveServiceBase =
    !catalogReferenceClassification?.targetServiceId &&
    (
      normalizedCurrentIntent === "info_servicio" ||
      normalizedCurrentIntent === "precio" ||
      normalizedCurrentIntent === "planes_precios" ||
      normalizedCurrentIntent === "info_horarios_generales" ||
      normalizedCurrentIntent === "schedule"
    ) &&
    (
      catalogReferenceClassification.kind === "entity_specific" ||
      catalogReferenceClassification.kind === "referential_followup" ||
      catalogReferenceClassification.kind === "variant_specific"
    );

  // IMPORTANTE:
  // Aunque ya exista un servicio previo en convoCtx, igual intentamos resolver
  // el texto ACTUAL para detectar si el usuario cambió explícitamente de servicio.
  let explicitServiceResolved = false;
  let explicitResolvedServiceId: string | null = null;
  let explicitResolvedServiceName: string | null = null;

  let shouldTryPreResolveService = false;

  if (shouldTryPreResolveServiceBase) {
    try {
      const candidateResult = await resolveServiceCandidatesFromText(
        pool,
        tenantId,
        userInput,
        { mode: "loose" }
      );

      shouldTryPreResolveService =
        shouldTryPreResolveServiceBase &&
        Boolean(candidateResult?.hit?.id) &&
        (
          catalogReferenceClassification.kind === "entity_specific" ||
          catalogReferenceClassification.kind === "variant_specific" ||
          (
            catalogReferenceClassification.kind === "referential_followup" &&
            Boolean(
              catalogReferenceClassification.targetServiceId ||
              convoCtx?.last_service_id ||
              convoCtx?.selectedServiceId
            )
          )
        );

      if (shouldTryPreResolveService && candidateResult?.hit?.id) {
        explicitServiceResolved = true;
        explicitResolvedServiceId = String(candidateResult.hit.id);
        explicitResolvedServiceName =
          String(candidateResult.hit.name || "").trim() || null;

        preResolvedCtxPatch.last_service_id = explicitResolvedServiceId;
        preResolvedCtxPatch.last_service_name = explicitResolvedServiceName;
        preResolvedCtxPatch.last_service_label = explicitResolvedServiceName;
        preResolvedCtxPatch.selectedServiceId = explicitResolvedServiceId;
        preResolvedCtxPatch.selectedServiceName = explicitResolvedServiceName;
        preResolvedCtxPatch.selectedServiceLabel = explicitResolvedServiceName;
        preResolvedCtxPatch.last_entity_kind = "service";
        preResolvedCtxPatch.last_entity_at = Date.now();

      }
    } catch (e: any) {
      console.warn(
        "[FASTPATH_HYBRID][PRE_RESOLVE_SERVICE] failed:",
        e?.message || e
      );
    }
  }

  const anchoredServiceId = firstNonEmptyString(
    convoCtx?.selectedServiceId,
    convoCtx?.last_service_id,
    convoCtx?.selected_service_id,
    convoCtx?.serviceId
  );

  const anchoredServiceName = firstNonEmptyString(
    convoCtx?.selectedServiceName,
    convoCtx?.last_service_name,
    convoCtx?.selected_service_name,
    convoCtx?.serviceName
  );

  const anchoredServiceLabel = firstNonEmptyString(
    convoCtx?.selectedServiceLabel,
    convoCtx?.last_service_label,
    convoCtx?.selected_service_label,
    convoCtx?.serviceLabel,
    anchoredServiceName
  );

  const shouldForceAnchoredService =
    shouldTryPreResolveService &&
    !explicitServiceResolved &&
    !!anchoredServiceId &&
    (followupNeedsAnchor === true || referentialFollowup === true) &&
    (!followupEntityKind || followupEntityKind === "service");

  const forcedAnchorCtxPatch: any = {};

  if (shouldForceAnchoredService) {
    forcedAnchorCtxPatch.last_service_id = anchoredServiceId;
    forcedAnchorCtxPatch.selectedServiceId = anchoredServiceId;
    forcedAnchorCtxPatch.last_service_name = anchoredServiceName || null;
    forcedAnchorCtxPatch.last_service_label =
      anchoredServiceLabel || anchoredServiceName || null;
    forcedAnchorCtxPatch.last_entity_kind = "service";
    forcedAnchorCtxPatch.last_entity_at = Date.now();

    if (process.env.DEBUG_FASTPATH === "true") {
    
    }
  }

  const convoCtxForFastpath = {
    ...(convoCtx || {}),
    ...forcedAnchorCtxPatch,
    ...preResolvedCtxPatch,
  };

  // 1️⃣ Ejecutar Fastpath "puro" (DB, includes, etc.)
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

  // Si no manejó nada, devolvemos directo
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
      ctxPatch: Object.keys(unhandledCtxPatch).length ? unhandledCtxPatch : undefined,
      intent: detectedIntent || intentFallback || null,
    };
  }

  // ✅ declarar ctxPatch primero
  const ctxPatch: any = fp.ctxPatch ? { ...fp.ctxPatch } : {};

  const shouldUseConvoCtxForStructuredService =
    fp.source === "price_fastpath_db_llm_render" ||
    fp.source === "price_fastpath_db_no_price_llm_render" ||
    fp.source === "price_fastpath_db" ||
    fp.source === "price_disambiguation_db" ||
    fp.source === "price_missing_db" ||
    (fp.source === "service_list_db" && fp.intent === "info_servicio");

  const canUseRoutingStructuredService =
  shouldUseRoutingStructuredService(catalogRoutingSignal);

  const routingTargetServiceId = canUseRoutingStructuredService
    ? firstNonEmptyString(
        catalogRoutingSignal?.targetServiceId,
        catalogReferenceClassification?.targetServiceId
      )
    : null;

  const routingTargetServiceName = canUseRoutingStructuredService
    ? firstNonEmptyString(
        catalogRoutingSignal?.targetServiceName,
        catalogReferenceClassification?.targetServiceName
      )
    : null;

  const routingStructuredService =
    routingTargetServiceId || routingTargetServiceName
      ? {
          serviceId: routingTargetServiceId,
          serviceName: routingTargetServiceName,
          serviceLabel: routingTargetServiceName,
          hasResolution: true,
        }
      : null;

  console.log("[STRUCTURED_SERVICE][ROUTING_GATE]", {
    tenantId,
    canal,
    contactoNorm,
    userInput,
    routeIntent: catalogRoutingSignal?.routeIntent || null,
    referenceKind: catalogRoutingSignal?.referenceKind || null,
    targetLevel: catalogRoutingSignal?.targetLevel || null,
    canUseRoutingStructuredService,
    routingTargetServiceId,
    routingTargetServiceName,
  });

  const structuredServiceBase = routingStructuredService
    ? routingStructuredService
    : shouldUseConvoCtxForStructuredService
    ? getStructuredServiceSelection(ctxPatch, convoCtxForFastpath)
    : getStructuredServiceSelection(ctxPatch, {});

  const shouldIgnoreStructuredService =
    fp.source === "price_disambiguation_db";

  const structuredService = shouldIgnoreStructuredService
    ? {
        serviceId: null,
        serviceName: null,
        serviceLabel: null,
        hasResolution: false,
      }
    : structuredServiceBase;

  const shouldBypassStructuredRewrite =
    isDmChatChannel(canal) &&
    Boolean(fp.reply) &&
    (
      String(ctxPatch?.last_bot_action || "") === "asked_link_option" ||
      Boolean(ctxPatch?.pending_link_lookup) ||
      (Array.isArray(ctxPatch?.pending_link_options) && ctxPatch.pending_link_options.length > 0)
    );

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
    structuredService.hasResolution &&
    fp.source !== "catalog_db" &&
    fp.source !== "price_disambiguation_db" &&
    !(fp.intent === "info_general");

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

  // ✅ HARD BYPASS: si Fastpath ya respondió desde DB con precios/catálogo,
  // NUNCA pasar por LLM (evita precios inventados).
  const HARD_BYPASS_PRICE_SOURCES = new Set([
    "price_summary_db",
    "price_fastpath_db",
    "price_disambiguation_db",
    "price_missing_db",
    "price_summary_db_empty",
  ]);

  const shouldAllowHardPriceBypass =
    catalogRoutingSignal.routeIntent === "catalog_price" ||
    catalogRoutingSignal.routeIntent === "catalog_alternatives" ||
    catalogRoutingSignal.routeIntent === "catalog_schedule" ||
    isCatalogDetailQuestion;

  if (
    isDmChatChannel(canal) &&
    HARD_BYPASS_PRICE_SOURCES.has(fp.source as any) &&
    shouldAllowHardPriceBypass
  ) {
    console.log("[CHAT][FASTPATH] HARD BYPASS DB_PRICE_SOURCE -> send fastpath (no LLM)", {
      source: fp.source,
      intent: fp.intent,
      shouldAllowHardPriceBypass,
    });

    return {
      handled: true,
      reply: fp.reply,
      replySource: fp.source,
      intent: fp.intent || detectedIntent || intentFallback || null,
      ctxPatch,
    };
  }

  // 2️⃣ awaitingEffect: set_awaiting_yes_no → lo manejamos aquí
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

  // 3️⃣ Texto factual base que sale de Fastpath
  let fastpathText = String(fp.reply || "");

  // 3.1️⃣ BYPASS LLM PARA DETALLE DE SERVICIO ("qué incluye X")
  // Si Fastpath ya resolvió info_servicio (incluye/qué trae), en WhatsApp/Meta
  // NO queremos pasar por el LLM: mandamos la respuesta tal cual.
  if (
    isDmChatChannel(canal) &&
    fp.source === "service_list_db" &&
    (fp.intent === "info_servicio" || isCatalogDetailQuestion)
  ) {
    console.log("[CHAT][FASTPATH] detalle_servicio directo (sin LLM)", {
      source: fp.source,
      intent: fp.intent,
      isCatalogDetailQuestion,
    });

    return {
      handled: true,
      reply: fastpathText,
      replySource: fp.source,
      intent: fp.intent || currentIntent || "info_servicio",
      ctxPatch,
    };
  }

  const isPlansList =
    fp.source === "service_list_db" &&
    (convoCtx as any)?.last_list_kind === "plan";

  const hasPkgs = (convoCtx as any)?.has_packages_available === true;

  // 3.5️⃣ WHATSAPP/META + PREGUNTA DE PRECIOS/PLANES: NO PASAR POR LLM
  // EXCEPCIÓN 1: si es "planes + horarios", dejamos que pase al modo híbrido
  // EXCEPCIÓN 2: tratamos distinto follow-up ("otros planes") y detalle de plan ("qué incluye")
  if (
    isDmChatChannel(canal) &&
    isPriceQuestionUser &&
    !wantsPlansAndHours &&
    !isCatalogDetailQuestion &&
    fp.source !== "catalog_db" &&
    fp.source !== "price_fastpath_db_llm_render" &&
    fp.source !== "price_fastpath_db_no_price_llm_render"
  ) {
    console.log("[CHAT][FASTPATH] Price question -> send fastpath", {
      source: fp.source,
      intent: fp.intent || detectedIntent || intentFallback || null,
      isMorePlansFollowup,
      isCatalogDetailQuestion,
    });

    let replyText = fastpathText;

    if (isMorePlansFollowup) {
      replyText = fastpathText;
    }

    return {
      handled: true,
      reply: replyText,
      replySource: fp.source,
      intent: fp.intent || detectedIntent || intentFallback || null,
      ctxPatch,
    };
  }

  // 🔍 detecta si ya trae link o viene de info_clave_*
  const isInfoClaveSource = String(fp.source || "").startsWith("info_clave");

  // 4️⃣ BYPASS LLM EN WHATSAPP/META si ya hay link o viene de info_clave
  if (isDmChatChannel(canal) && isInfoClaveSource) {
    console.log("[CHAT][FASTPATH] Bypass LLM (link/info_clave)", {
      source: fp.source,
    });

    console.log("[FASTPATH_HYBRID][RETURN_HARD_PRICE_BYPASS]", {
      tenantId,
      canal,
      userInput,
      fpSource: fp.source,
      fpIntent: fp.intent,
      ctxPatch,
    });

    return {
      handled: true,
      reply: fastpathText,
      replySource: fp.source,
      intent: fp.intent || detectedIntent || intentFallback || null,
      ctxPatch,
    };
  }

  // 5️⃣ Para otros canales, naturalizar línea secundaria (planes + paquetes)
  if (canal !== "whatsapp" && isPlansList && hasPkgs) {
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

  // 6️⃣ MODO HÍBRIDO PARA WHATSAPP Y META (FB/IG)
  const isDm = isDmChatChannel(canal);

  const isServiceIntent =
    (fp.intent || detectedIntent || intentFallback || null) === "info_servicio";

  const SERVICE_GROUNDED_SOURCES = new Set([
    "service_list_db",
    "catalog_db",
    "price_summary_db",
    "price_fastpath_db",
    "price_disambiguation_db",
  ]);

  const hasStructuredServiceResolution = structuredService.hasResolution;
  const hasGroundedServiceSource = SERVICE_GROUNDED_SOURCES.has(String(fp.source || ""));

  if (isDm && isServiceIntent && (!hasStructuredServiceResolution || !hasGroundedServiceSource)) {
    return {
      handled: true,
      reply: fastpathText,
      replySource: fp.source,
      intent: fp.intent || detectedIntent || intentFallback || null,
      ctxPatch,
    };
  }

  if (isDm) {
    const history = await getRecentHistoryForModel({
      tenantId,
      canal,
      fromNumber: contactoNorm,
      excludeMessageId: messageId || undefined,
      limit: 12,
    });

    const NO_NUMERIC_MENUS =
      idiomaDestino === "en"
        ? "RULE: Do NOT present numbered menus or ask the user to reply with a number. If you need clarification, ask ONE short question. Numbered picks are handled by the system, not you."
        : "REGLA: NO muestres menús numerados ni pidas que respondan con un número. Si necesitas aclarar, haz UNA sola pregunta corta. Las selecciones por número las maneja el sistema, no tú.";

    const PRICE_QUALIFIER_RULE =
      idiomaDestino === "en"
        ? "RULE: If a price is described as 'FROM/STARTING AT' (or 'desde'), you MUST keep that qualifier. Never rewrite it as an exact price. Use: 'starts at $X' / 'from $X'."
        : "REGLA: Si un precio está descrito como 'DESDE' (o 'from/starting at'), DEBES mantener ese calificativo. Nunca lo conviertas en precio exacto. Usa: 'desde $X'.";

    const NO_PRICE_INVENTION_RULE =
      idiomaDestino === "en"
        ? "RULE: Do not invent exact prices. Only mention prices if explicitly present in the provided business info or in SYSTEM_STRUCTURED_DATA, and preserve ranges/qualifiers."
        : "REGLA: No inventes precios exactos. Solo menciona precios si están explícitos en la info del negocio o en DATOS_ESTRUCTURADOS_DEL_SISTEMA, y preserva rangos/calificativos (DESDE).";

    const PRICE_LIST_FORMAT_RULE =
      idiomaDestino === "en"
        ? [
            "RULE: If your reply mentions any prices or plans from SYSTEM_STRUCTURED_DATA, you MUST format them as a bullet list.",
            "- You may start with 0–1 very short intro line (e.g. 'Main prices are:').",
            "- Then put ONE option per line like: '• Plan Gold Autopay: $165.99/month – short benefit'.",
            "- NEVER put several different prices or plans in one long paragraph.",
            "- If the user also asks about schedules/hours, answer hours in 1 short sentence and then show the prices as a bullet list.",
          ].join(" ")
        : [
            "REGLA: Si tu respuesta menciona precios o planes tomados de DATOS_ESTRUCTURADOS_DEL_SISTEMA, DEBES formatearlos como lista con viñetas.",
            "- Puedes empezar con 0–1 línea muy corta de introducción (por ejemplo: 'Los precios principales son:').",
            "- Luego usa UNA línea por opción, por ejemplo: '• Plan Gold Autopay: $165.99/mes – beneficio breve'.",
            "- NUNCA metas varios precios o planes distintos en un solo párrafo largo.",
            "- Si el usuario también pregunta por horarios, responde los horarios en 1 frase corta y después muestra los precios como lista con viñetas.",
          ].join(" ");

    const CHANNEL_TONE_RULE =
      idiomaDestino === "en"
        ? "RULE: You may rephrase for a natural, warm, sales-oriented chat/DM tone, but DO NOT change amounts, ranges, or plan/service names."
        : "REGLA: Puedes re-redactar para que suene natural, cálido y vendedor en chat/DM, pero NO cambies montos, rangos ni nombres de planes/servicios.";

    // Bloque especial solo cuando pidió “planes + horarios”
    let forcedListBlock = "";
    if (wantsPlansAndHours && infoClave) {
      forcedListBlock =
        idiomaDestino === "es"
          ? `
REGLA ESPECIAL PARA ESTE TURNO:
- El usuario pidió PLANES + HORARIOS.
- Debes responder SIEMPRE en formato LISTA.
- Prohibido párrafos largos.
- Estructura EXACTA:
  1) "Planes principales:" seguido de 3–5 bullets (un plan por línea).
  2) "Horarios:" seguido de bullets con horarios extraídos SOLO de BUSINESS_GENERAL_INFO (info_clave).
  3) El link de reservas en su propia línea.
  4) CTA final en 1 línea.
- NO inventes horarios. Usa solo los que aparezcan literalmente en BUSINESS_GENERAL_INFO.
- NO resumas horarios como "varían" ni "desde temprano". Usa solo los reales.
          `
          : `
SPECIAL RULE FOR THIS TURN:
- The user asked for PLANS + HOURS.
- You MUST answer in LIST FORMAT.
- No long paragraphs.
- Structure:
  1) "Main plans:" with 3–5 bullet lines.
  2) "Schedules:" with bullets using ONLY hours found in BUSINESS_GENERAL_INFO.
  3) Booking link as a separate line.
  4) CTA in one line.
- DO NOT invent hours. Use only literal ones.
          `;
    }

    const SALES_OPENING_RULE =
      idiomaDestino === "en"
        ? [
            "SALES OPENING RULE:",
            "- If the user asks generally about prices/options/plans, do NOT start cold or robotic.",
            "- Start with ONE short, natural, sales-oriented line.",
            "- Good style: open like a sales advisor, not like a catalog.",
            "- The first line should sound useful, warm, and oriented toward helping the user choose.",
            "- Avoid flat intros like 'Here are the prices' or 'these are the prices'.",
            "- Prefer openings like: 'To give you a better idea, these are some of the main options.'",
            "- Or a short natural variation of that style, without sounding repetitive.",
          ].join("\n")
        : [
            "REGLA DE APERTURA COMERCIAL:",
            "- Si el usuario pregunta de forma general por precios/opciones/planes, NO empieces frío ni robótico.",
            "- Empieza con UNA sola línea corta, natural y comercial.",
            "- Buen estilo: abre como un asesor comercial, no como un catálogo.",
            "- La primera línea debe sonar útil, cálida y orientada a ayudar a elegir.",
            "- Evita aperturas planas como 'Aquí tienes los precios' o 'estos son los precios'.",
            "- Prefiere aperturas como: 'Para que tengas una idea, estas son algunas de las opciones principales.'",
            "- O una variante breve y natural del mismo estilo, sin sonar repetitivo.",
          ].join("\n");

    const SALES_CTA_RULE =
      idiomaDestino === "en"
        ? [
            "SALES CTA RULE:",
            "- Always close with ONE short next-step CTA.",
            "- The CTA should feel consultative and sales-oriented, not generic.",
            "- It should naturally invite the next step: helping the user choose, recommending an option, or moving toward booking.",
            "- Avoid weak closings like 'let me know' with no context.",
            "- Prefer closings that help the user decide or move forward.",
            "- Do NOT sound pushy or forced.",
          ].join("\n")
        : [
            "REGLA DE CTA COMERCIAL:",
            "- Cierra siempre con UN solo CTA corto para continuar la conversación.",
            "- El CTA debe sonar consultivo y vendedor, no genérico.",
            "- Debe invitar al siguiente paso de forma natural: ayudar a elegir, recomendar una opción o avanzar a reservar.",
            "- Evita cierres débiles como 'déjame saber' sin contexto.",
            "- Prefiere cierres que ayuden a decidir o avanzar.",
            "- No suenes agresivo ni forzado.",
          ].join("\n");

    const promptConFastpath = [
      promptBaseMem,
      "",
      forcedListBlock,
      "",
      "DATOS_ESTRUCTURADOS_DEL_SISTEMA (úsalos como fuente de verdad, sin cambiar montos ni nombres de planes/servicios):",
      fastpathText,
      "",
      "INSTRUCCIONES_DE_ESTILO_PARA_ESTE TURNO:",
      NO_NUMERIC_MENUS,
      PRICE_QUALIFIER_RULE,
      NO_PRICE_INVENTION_RULE,
      PRICE_LIST_FORMAT_RULE,
      CHANNEL_TONE_RULE,
      "",
      SALES_OPENING_RULE,
      "",
      SALES_CTA_RULE,
    ].join("\n");

    const isCatalogDbReply = String(fp.source || "") === "catalog_db";
    const isPriceDisambiguationReply =
      String(fp.source || "") === "price_disambiguation_db";

    const hasResolvedEntity = Boolean(
      structuredService?.serviceId ||
      structuredService?.serviceLabel
    );

    const shouldUseGroundedFrameOnly =
      isCatalogDbReply || isPriceDisambiguationReply;

    // ===============================
    // ✅ BYPASS TEMPRANO PARA PRECIOS GROUNDED DEL FASTPATH
    // No volver a pasar por answerWithPromptBase.
    // ===============================
    if (
      fp?.handled &&
      (
        fp?.source === "price_fastpath_db_llm_render" ||
        fp?.source === "price_fastpath_db"
      ) &&
      typeof fastpathText === "string" &&
      fastpathText.trim().length > 0
    ) {

      const finalDmReply = stripMarkdownLinksForDm(fastpathText);

      return {
        handled: true,
        reply: finalDmReply,
        replySource: fp.source,
        intent: fp.intent || detectedIntent || intentFallback || null,
        ctxPatch,
      };
    }

    const composed = await answerWithPromptBase({
      tenantId,
      promptBase: promptConFastpath,
      userInput,
      history,
      idiomaDestino,
      canal,
      maxLines: MAX_WHATSAPP_LINES,
      fallbackText: fastpathText,

      responsePolicy: {
        mode: shouldUseGroundedFrameOnly
          ? "grounded_frame_only"
          : hasResolvedEntity
          ? "grounded_only"
          : "clarify_only",

        resolvedEntityType:
          hasResolvedEntity && !isCatalogDbReply ? "service" : null,
        resolvedEntityId:
          hasResolvedEntity && !isCatalogDbReply
            ? structuredService?.serviceId ?? null
            : null,
        resolvedEntityLabel:
          hasResolvedEntity && !isCatalogDbReply
            ? structuredService?.serviceLabel ?? null
            : null,

        canMentionSpecificPrice: isCatalogDbReply || hasResolvedEntity,
        canSelectSpecificCatalogItem: isCatalogDbReply || hasResolvedEntity,
        canOfferBookingTimes: false,
        canUseCatalogLists: isCatalogDbReply || hasResolvedEntity,
        canUseOfficialLinks: true,
        unresolvedEntity: !isCatalogDbReply && !hasResolvedEntity,
        clarificationTarget: !isCatalogDbReply && !hasResolvedEntity ? "service" : null,

        singleResolvedEntityOnly: hasResolvedEntity && !isCatalogDbReply,
        allowAlternativeEntities: false,
        allowCrossSellEntities: false,
        allowAddOnSuggestions: false,

        preserveExactBody: shouldUseGroundedFrameOnly,
        preserveExactOrder: shouldUseGroundedFrameOnly,
        preserveExactBullets: shouldUseGroundedFrameOnly,
        preserveExactNumbers: shouldUseGroundedFrameOnly,
        preserveExactLinks: shouldUseGroundedFrameOnly,
        allowIntro: true,
        allowOutro: true,
        allowBodyRewrite: !shouldUseGroundedFrameOnly,

        reasoningNotes: isCatalogDbReply
          ? "Catalog DB reply: improve framing only, never alter the canonical body."
          : isPriceDisambiguationReply
          ? "Variant/price disambiguation reply: improve framing only, never alter the canonical body."
          : null,
      },
    });

    if (composed.pendingCta) {
      ctxPatch.pending_cta = {
        ...composed.pendingCta,
        createdAt: new Date().toISOString(),
      };

    }

    // 7️⃣ awaiting_yes_no_action SOLO por señal estructurada, nunca por regex del texto
    if (fp?.awaitingEffect?.type === "set_awaiting_yes_no") {
      const payload = fp.awaitingEffect.payload || null;

      if (payload?.kind) {
        ctxPatch.awaiting_yes_no_action = payload;
      }
    }

    const finalDmReply = stripMarkdownLinksForDm(composed.text);

    return {
      handled: true,
      reply: finalDmReply,
      replySource: fp.source,
      intent: fp.intent || detectedIntent || intentFallback || null,
      ctxPatch,
    };
  }

  console.log("[DM_CHANNEL_CHECK]", { canal, isDm });
  
  // 8️⃣ Otros canales (no WhatsApp/Meta): devolvemos fastpath “plano”
  return {
    handled: true,
    reply: fastpathText,
    replySource: fp.source,
    intent: fp.intent || detectedIntent || intentFallback || null,
    ctxPatch,
  };
}