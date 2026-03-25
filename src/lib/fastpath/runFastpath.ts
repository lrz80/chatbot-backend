// backend/src/lib/fastpath/runFastpath.ts
import type { Pool } from "pg";

import type { Canal } from "../detectarIntencion";
import type { Lang } from "../channels/engine/clients/clientDb";

import { traducirMensaje } from "../traducirMensaje";
import { traducirTexto } from "../traducirTexto";

// INFO_CLAVE includes
import { normalizeText } from "../infoclave/resolveIncludes";

// DB catalog includes
import { getServiceDetailsText } from "../services/resolveServiceInfo";

// Pricing
import { resolveServiceIdFromText } from "../services/pricing/resolveServiceIdFromText";
import { resolveBestLinkForService } from "../links/resolveBestLinkForService";
import { renderInfoGeneralOverview } from "../fastpath/renderInfoGeneralOverview";
import { getServiceAndVariantUrl } from "../services/getServiceAndVariantUrl";
import { buildCatalogContext } from "../catalog/buildCatalogContext";
import { renderGenericPriceSummaryReply } from "../services/pricing/renderGenericPriceSummaryReply";
import { answerCatalogQuestionLLM } from "./llm/answerCatalogQuestionLLM";
import { extractQueryFrames } from "./extractQueryFrames";
import { resolveServiceMatchesFromText } from "../services/pricing/resolveServiceMatchesFromText";
import { answerWithPromptBase } from "../answers/answerWithPromptBase";

import type { CatalogReferenceClassification } from "../catalog/types";

import { buildCatalogRoutingSignal } from "../../lib/catalog/buildCatalogRoutingSignal";

import { runCatalogFastpath } from "./handlers/catalog/runCatalogFastpath";
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
  postProcessCatalogReply,
  sameBulletStructure,
} from "./helpers/catalogTextMatching";
import { renderFreeOfferList } from "./helpers/catalogRendering";
import { normalizeCatalogRole } from "../catalog/normalizeCatalogRole";
import { renderCatalogReplyWithSalesFrame } from "./helpers/catalogRendering";

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
    | "unknown"
    | null;

  expectedVariantIntent?:
    | "price_or_plan"
    | "other_plans"
    | "combination_and_price"
    | "includes"
    | "schedule"
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
        |"price_fastpath_db_llm_render"
        |"price_fastpath_db_no_price_llm_render";
      intent: string | null;
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

  const q = userInput.toLowerCase().trim();

  if (inBooking) return { handled: false };

  const intentOut = (detectedIntent || "").trim() || null;

  const catalogReferenceKind =
    catalogReferenceClassification?.kind ?? "none";

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
    catalogReferenceKind === "referential_followup";

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
      answerCatalogQuestionLLM,
      renderCatalogReplyWithSalesFrame,
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
  // ✅ INFO GENERAL OVERVIEW
  // browse general de catálogo sin entidad resuelta
  // ===============================
  {
    const wantsCatalogOverview =
      !catalogReferenceClassification?.targetServiceId &&
      !catalogReferenceClassification?.targetVariantId &&
      !detectedFacets?.asksPrices &&
      !detectedFacets?.asksSchedules &&
      !detectedFacets?.asksLocation &&
      !detectedFacets?.asksAvailability &&
      (
        catalogReferenceClassification?.kind === "catalog_overview" ||
        intentOut === "info_general" ||
        intentOut === "info_servicio"
      );

    if (wantsCatalogOverview) {
      const ctxPatch: any = {
        last_list_kind: null,
        last_list_kind_at: null,
        last_plan_list: null,
        last_plan_list_at: null,
        last_package_list: null,
        last_package_list_at: null,
      };

      const canonicalReply = await renderInfoGeneralOverview({
        pool,
        tenantId,
        lang: idiomaDestino,
      });

      const reply = await renderCatalogReplyWithSalesFrame({
        lang: idiomaDestino,
        userInput,
        canonicalReply,
        answerCatalogQuestionLLM,
        mode: "grounded_frame_only",
        maxIntroLines: 1,
        maxClosingLines: 1,
      });

      return {
        handled: true,
        source: "service_list_db",
        intent: intentOut,
        reply,
        ctxPatch,
      };
    }
  }

  // ===============================
  // ✅ RESOLVER SELECCIÓN PENDIENTE DE LINK/VARIANTE
  // ===============================
  {
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
  {
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
    const freeOfferResult = await handleFreeOffer({
      pool,
      tenantId,
      idiomaDestino,
      detectedIntent,
      catalogReferenceClassification,
      convoCtx,
      renderFreeOfferList,
      answerCatalogQuestionLLM,
      renderCatalogReplyWithSalesFrame,
    });

    if (freeOfferResult.handled) {
      return freeOfferResult;
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
      answerCatalogQuestionLLM,
      renderCatalogReplyWithSalesFrame,
    });

    if (interestToLinkResult.handled) {
      return interestToLinkResult;
    }
  }

  // =========================================================
  // ✅ FOLLOW-UP ROUTER
  // =========================================================
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

  // ===============================
  // ✅ FOLLOW-UP DE VARIANTE DEL MISMO SERVICIO (GENÉRICO / MULTITENANT)
  // Si ya estamos parados en un servicio con variantes y el usuario
  // menciona una variante, responder directo sin relistar.
  // ===============================
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
    answerWithPromptBase,
    promptBase,
    canal,
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
      answerCatalogQuestionLLM,
      renderCatalogReplyWithSalesFrame,
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
  // 🧠 MOTOR ÚNICO DE CATÁLOGO
  // ===============================
  const catalogFastpathResult = await runCatalogFastpath({
    pool,
    tenantId,
    userInput,
    idiomaDestino,
    convoCtx,
    intentOut,
    detectedIntent,
    infoClave,
    promptBase,
    canal,
    hasStructuredTarget,
    catalogReferenceClassification,
    facets: detectedFacets || {},
    buildCatalogRoutingSignal,
    buildCatalogContext,
    normalizeCatalogRole,
    traducirTexto,
    renderGenericPriceSummaryReply,
    extractPlanNamesFromReply,
    sameBulletStructure,
    answerWithPromptBase,
    answerCatalogQuestionLLM,
    postProcessCatalogReply,
  });

  if (catalogFastpathResult.handled) {
    return catalogFastpathResult;
  }

  return { handled: false };
}
