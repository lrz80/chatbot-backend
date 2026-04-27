// backend/src/lib/fastpath/runFastpath.ts
import type { Pool } from "pg";

import type { Canal } from "../detectarIntencion";
import type { Lang } from "../channels/engine/clients/clientDb";

import { traducirMensaje } from "../traducirMensaje";

// INFO_CLAVE includes
import { normalizeText } from "../infoclave/resolveIncludes";

// DB catalog includes
import { getServiceDetailsText } from "../services/resolveServiceInfo";

// Pricing
import {
  resolveServiceIdFromText,
} from "../services/pricing/resolveServiceIdFromText";
import { resolveBestLinkForService } from "../links/resolveBestLinkForService";
import { getServiceAndVariantUrl } from "../services/getServiceAndVariantUrl";
import { extractQueryFrames } from "./extractQueryFrames";
import { resolveServiceMatchesFromText } from "../services/pricing/resolveServiceMatchesFromText";

import type { CatalogReferenceClassification } from "../catalog/types";

import { buildCatalogRoutingSignal } from "../../lib/catalog/buildCatalogRoutingSignal";

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
} from "./helpers/catalogTextMatching";
import { runCatalogDomainTurn } from "./runCatalogDomainTurn";

type IntentFacets = {
  asksPrices?: boolean;
  asksSchedules?: boolean;
  asksLocation?: boolean;
  asksAvailability?: boolean;
};

export type FastpathCtx = {
  last_service_id?: string | null;
  last_service_name?: string | null;
  last_service_at?: number | null;

  pending_price_lookup?: boolean;
  pending_price_at?: number | null;
  pending_price_target_text?: string | null;
  pending_price_raw_user_text?: string | null;

  // ✅ listas para selección posterior
  last_plan_list?: Array<{ id: string; name: string; url: string | null }>;
  last_plan_list_at?: number | null;

  last_package_list?: Array<{ id: string; name: string; url: string | null }>;
  last_package_list_at?: number | null;

  // ✅ señales estructurales (SIN COPY)
  has_packages_available?: boolean;
  has_packages_available_at?: number | null;

  last_list_kind?: "plan" | "package";
  last_list_kind_at?: number | null;

  pending_link_lookup?: boolean;
  pending_link_at?: number | null;
  pending_link_options?: Array<{ label: string; url: string }>;

  last_bot_action?: string | null;
  last_bot_action_at?: number | null;

  last_price_option_label?: string | null;
  last_price_option_at?: number | null;

  last_selected_kind?: "service" | "option" | "plan" | "package" | null;
  last_selected_id?: string | null;
  last_selected_name?: string | null;
  last_selected_at?: number | null;

  // ✅ histórico de planes listados por el motor de catálogo
  last_catalog_plans?: string[] | null;
  last_catalog_at?: number | null;

  lastPresentedEntityIds?: string[] | null;
  lastPresentedFamilyKeys?: string[] | null;
  last_catalog_scope?: "overview" | "entity" | "family" | "variant" | null;
  last_catalog_source?: "info_clave" | "db_catalog" | null;

  // selección de servicio/variante para flujo "qué incluye"
  selectedServiceId?: string | null;
  expectingVariant?: boolean;

  last_variant_id?: string | null;
  last_variant_name?: string | null;
  last_variant_url?: string | null;
  last_variant_at?: number | null;

  lastResolvedIntent?:
    | "price_or_plan"
    | "other_plans"
    | "combination_and_price"
    | "includes"
    | "schedule"
    | "schedule_and_price"
    | "business_info_facets"
    | "info_general_overview"
    | "compare"
    | "catalog_disambiguation"
    | "unknown"
    | null;

  expectedVariantIntent?:
    | "price_or_plan"
    | "other_plans"
    | "combination_and_price"
    | "includes"
    | "schedule"
    | "compare"
    | "unknown"
    | null;
  [k: string]: any;
};

export type FastpathAwaitingEffect =
  | {
      type: "set_awaiting_yes_no";
      ttlSeconds: number;
      payload: any;
    }
  | { type: "none" };

export type FastpathHint =
  | {
      type: "price_summary";
      payload: {
        lang: Lang;
        rows: { service_name: string; min_price: number; max_price: number }[];
      };
    };

type CatalogChoiceOption =
  | {
      kind: "service";
      serviceId: string;
      label: string;
      serviceName?: string | null;
    }
  | {
      kind: "variant";
      serviceId: string;
      variantId: string;
      label: string;
      serviceName?: string | null;
      variantName?: string | null;
    };

type CatalogPayload =
  | {
      kind: "service_choice";
      originalIntent: string | null;
      options: CatalogChoiceOption[];
    }
  | {
      kind: "catalog_family_guided";
      originalIntent: string | null;
      options: Array<{
        kind: "service";
        serviceId: string;
        label: string;
        serviceName?: string | null;
      }>;
    }
  | {
      kind: "variant_choice";
      originalIntent: string | null;
      serviceId: string;
      serviceName: string | null;
      options: CatalogChoiceOption[];
    }
  | {
      kind: "resolved_catalog_answer";
      scope: "service" | "variant" | "family" | "overview";
      presentationMode?: "full_detail" | "action_link";
      closingMode?: "default" | "availability_statement" | "none";
      serviceId?: string | null;
      serviceName?: string | null;
      variantId?: string | null;
      variantName?: string | null;
      canonicalBlocks: {
        priceBlock?: string | null;
        includesBlock?: string | null;
        scheduleBlock?: string | null;
        locationBlock?: string | null;
        availabilityBlock?: string | null;
        servicesBlock?: string | null;
        linkBlock?: string | null;
      };
    };

export type FastpathResult =
  | {
      handled: true;
      reply: string;
      source:
        | "service_list_db"
        | "info_clave_includes"
        | "info_clave_missing_includes"
        | "includes_fastpath_db"
        | "includes_fastpath_db_missing"
        | "includes_fastpath_db_ambiguous"
        | "price_disambiguation_db"
        | "price_missing_db"
        | "price_fastpath_db"
        | "price_summary_db"
        | "info_general_overview"
        | "price_summary_db_empty"
        | "info_clave_includes_ctx_link"
        | "interest_to_pricing"
        | "catalog_llm"
        | "fastpath_dismiss"
        | "catalog_db"
        | "price_fastpath_db_llm_render"
        | "price_summary_db_llm_render"
        | "catalog_comparison_db_llm_render"
        | "price_fastpath_db_no_price"
        | "price_fastpath_db_no_price_llm_render"
        | "catalog_disambiguation_db"
        | "info_clave_db";
      intent: string | null;
      catalogPayload?: CatalogPayload;
      ctxPatch?: Partial<FastpathCtx>;
      awaitingEffect?: FastpathAwaitingEffect;
      fastpathHint?: FastpathHint;
    }
  | {
      handled: false;
      ctxPatch?: Partial<FastpathCtx>;
      fastpathHint?: FastpathHint;
    };

export type RunFastpathArgs = {
  pool: Pool;

  tenantId: string;
  canal: Canal;

  idiomaDestino: Lang;
  userInput: string;

  // Importante: el caller define si está en booking
  inBooking: boolean;

  // state context actual
  convoCtx: FastpathCtx;

  // multi-tenant: info_clave viene del tenant
  infoClave: string;
  promptBase: string;

  // intent detectada (si existe) para logging/guardado
  detectedIntent?: string | null;
  detectedFacets?: IntentFacets | null;

  // knobs
  maxDisambiguationOptions?: number; // default 5
  lastServiceTtlMs?: number; // default 60 min

  catalogReferenceClassification?: CatalogReferenceClassification;
};

export async function runFastpath(args: RunFastpathArgs): Promise<FastpathResult> {
  const {
    pool,
    tenantId,
    canal,
    idiomaDestino,
    userInput,
    inBooking,
    convoCtx: initialConvoCtx,
    infoClave,
    promptBase,
    detectedIntent,
    detectedFacets,
    catalogReferenceClassification,
    maxDisambiguationOptions = 5,
  } = args;

  let convoCtx = initialConvoCtx;

  const hasPendingCatalogChoice =
    Boolean(convoCtx?.pendingCatalogChoice) &&
    (
      convoCtx?.pendingCatalogChoice?.kind === "service_choice" ||
      convoCtx?.pendingCatalogChoice?.kind === "variant_choice"
    );

  const q = userInput.toLowerCase().trim();

  if (inBooking) return { handled: false };

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

  const { isFreshCatalogPriceTurn } = getCatalogRoutingState({
    detectedIntent,
    isStructuredCatalogTurn,
    catalogReferenceClassification,
    convoCtx,
    buildCatalogRoutingSignal,
  });

  // ===============================
  // ✅ MULTI-QUESTION SPLIT + ANSWER
  // ===============================
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

  // ===============================
  // ✅ Dismiss Fastpath
  // ===============================
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

  // ===============================
  // ✅ CATALOG COMPARISON
  // comparación entre 2 entidades del catálogo
  // ===============================
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

  // ===============================
  // ✅ RESOLVER SELECCIÓN PENDIENTE DE LINK/VARIANTE
  // ===============================
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

  // ===============================
  // ✅ PICK FROM LAST LIST
  // ===============================
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

  // ===============================
  // ✅ ANTI-LOOP PENDING LINK
  // ===============================
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

  // ===============================
  // ✅ FREE OFFER
  // ===============================
  {
    const shouldAllowGenericFreeOfferHandler =
      !hasConcreteTargetThisTurn &&
      catalogReferenceClassification?.kind !== "entity_specific" &&
      catalogReferenceClassification?.kind !== "variant_specific";

    if (shouldAllowGenericFreeOfferHandler) {
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
  }

  // ===============================
  // ✅ INTEREST -> LINK
  // ===============================
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

  // =========================================================
  // ✅ FOLLOW-UP ROUTER
  // =========================================================
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

  // ===============================
  // ✅ FOLLOW-UP DE VARIANTE DEL MISMO SERVICIO (GENÉRICO / MULTITENANT)
  // Si ya estamos parados en un servicio con variantes y el usuario
  // menciona una variante, responder directo sin relistar.
  // ===============================
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

  // ===============================
  // ✅ VARIANTES: SEGUNDO TURNO
  // El usuario ya vio las opciones y ahora elige una (1, "autopay", etc.)
  // ===============================
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

  // ===============================
  // ✅ VARIANTES: PRIMER TURNO
  // (sin regex ni texto raw; solo señales estructuradas)
  // ===============================
  const catalogRouteIntent = String(intentOut || "").trim().toLowerCase() || null;

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
  
  // ===============================
  // 🧠 ENTRYPOINT DE DOMINIO CATÁLOGO
  // ===============================
  const canEnterCatalogDomain =
    !shouldBypassCatalogFollowupReuse &&
    (
      hasPendingCatalogChoice ||
      isStructuredCatalogTurn
    );

  if (shouldBypassCatalogFollowupReuse) {
    return { handled: false };
  }

  if (!canEnterCatalogDomain) {
    return { handled: false };
  }

  return await runCatalogDomainTurn({
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
    catalogReferenceClassification,
    maxDisambiguationOptions,
  });

  return { handled: false };
}
