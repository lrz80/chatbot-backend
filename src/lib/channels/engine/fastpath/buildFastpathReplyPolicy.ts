import type {
  Canal,
  CommercialSignal,
} from "../../../detectarIntencion";

export type StructuredServiceSelection = {
  serviceId: string | null;
  serviceName: string | null;
  serviceLabel: string | null;
  hasResolution: boolean;
};

export type FastpathReplyPolicyInput = {
  canal: Canal;
  fp: {
    handled: boolean;
    source?: string | null;
    intent?: string | null;
    reply?: string | null;
    ctxPatch?: any;
    awaitingEffect?: any;
  };
  detectedIntent?: string | null;
  intentFallback?: string | null;
  detectedCommercial?: CommercialSignal | null;
  catalogRoutingSignal?: any;
  catalogReferenceClassification?: any;
  structuredService: StructuredServiceSelection;
  ctxPatch?: any;
};

export type FastpathReplyPolicy = {
  isDmChannel: boolean;
  shouldBypassStructuredRewrite: boolean;
  shouldPersistStructuredService: boolean;
  shouldHardBypassReply: boolean;
  shouldDirectReturnInfoBlock: boolean;
  shouldDirectReturnPriceLikeReply: boolean;
  shouldRunDmRewrite: boolean;
  shouldUseGroundedFrameOnly: boolean;
  hasResolvedEntity: boolean;

  isCatalogDbReply: boolean;
  isPriceSummaryReply: boolean;
  isPriceDisambiguationReply: boolean;
  isGroundedCatalogReply: boolean;
  isGroundedCatalogOverviewDm: boolean;
  shouldForceSalesClosingQuestion: boolean;

  canonicalBodyOwnsClosing: boolean;

  replySourceKind:
    | "catalog_comparison_render"
    | "catalog_grounded"
    | "catalog_disambiguation"
    | "business_info"
    | "price_like"
    | "service_detail"
    | "generic";
  responsePolicyMode:
    | "grounded_frame_only"
    | "grounded_only"
    | "clarify_only";

  commercialPolicy: {
    purchaseIntent: "unknown" | "low" | "medium" | "high";
    wantsBooking: boolean;
    wantsQuote: boolean;
    wantsHuman: boolean;
    urgency: "unknown" | "low" | "medium" | "high";
    shouldUseSalesTone: boolean;
    shouldUseSoftClosing: boolean;
    shouldUseDirectClosing: boolean;
    shouldSuggestHumanHandoff: boolean;
  };
};

function toNormalizedString(value: any): string {
  return String(value ?? "").trim().toLowerCase();
}

function isDmChatChannel(canal: Canal): boolean {
  const normalized = toNormalizedString(canal);
  return (
    normalized === "whatsapp" ||
    normalized === "facebook" ||
    normalized === "instagram"
  );
}

function hasPendingLinkState(ctxPatch: any): boolean {
  return Boolean(
    ctxPatch?.pending_link_lookup ||
      (Array.isArray(ctxPatch?.pending_link_options) &&
        ctxPatch.pending_link_options.length > 0) ||
      String(ctxPatch?.last_bot_action || "").trim() === "asked_link_option"
  );
}

function isVariantDisambiguationState(input: {
  fp: FastpathReplyPolicyInput["fp"];
  ctxPatch?: any;
  structuredService: StructuredServiceSelection;
}): boolean {
  const fpSource = String(input.fp?.source || "").trim();
  const reply = String(input.fp?.reply || "").trim();

  if (fpSource === "price_disambiguation_db") {
    return true;
  }

  if (
    input.structuredService?.hasResolution &&
    input.ctxPatch?.expectingVariant === true &&
    !input.ctxPatch?.last_variant_id &&
    !input.ctxPatch?.last_variant_name
  ) {
    return true;
  }

  if (
    input.structuredService?.hasResolution &&
    !input.ctxPatch?.last_variant_id &&
    !input.ctxPatch?.last_variant_name &&
    reply.length > 0 &&
    Array.isArray(input.ctxPatch?.last_variant_options) &&
    input.ctxPatch.last_variant_options.length > 1
  ) {
    return true;
  }

  return false;
}

function isServiceChoiceDisambiguationState(input: {
  fp: FastpathReplyPolicyInput["fp"];
  catalogRoutingSignal?: any;
  structuredService: StructuredServiceSelection;
}): boolean {
  const fpSource = toNormalizedString(input.fp?.source);
  const targetLevel = toNormalizedString(
    input.catalogRoutingSignal?.targetLevel
  );
  const disambiguationType = toNormalizedString(
    input.catalogRoutingSignal?.disambiguationType
  );

  if (fpSource === "catalog_disambiguation_db") {
    return true;
  }

  return (
    !input.structuredService?.hasResolution &&
    targetLevel === "ambiguous_entity" &&
    disambiguationType === "service_choice"
  );
}

function getReplySourceKind(params: {
  fpSource: string;
  structuredService: StructuredServiceSelection;
  catalogReferenceClassification?: any;
  catalogRoutingSignal?: any;
}): FastpathReplyPolicy["replySourceKind"] {
  const fpSource = params.fpSource;
  const hasResolvedEntity = Boolean(params.structuredService?.hasResolution);

  if (fpSource === "catalog_comparison_db") {
    return "catalog_comparison_render";
  }

  if (
    fpSource === "price_disambiguation_db" ||
    fpSource === "catalog_disambiguation_db"
  ) {
    return "catalog_disambiguation";
  }

  if (fpSource.startsWith("info_clave")) {
    return "business_info";
  }

  if (
    fpSource === "price_fastpath_db" ||
    fpSource === "price_fastpath_db_no_price" ||
    fpSource === "price_summary_db" ||
    fpSource === "price_missing_db"
  ) {
    return "price_like";
  }

  if (fpSource === "service_list_db" && hasResolvedEntity) {
    return "service_detail";
  }

  if (fpSource === "catalog_db") {
    return "catalog_grounded";
  }

  if (params.catalogRoutingSignal?.routeIntent === "catalog_compare") {
    return "catalog_comparison_render";
  }

  return "generic";
}

function normalizePurchaseIntent(
  value: unknown
): "unknown" | "low" | "medium" | "high" {
  const normalized = toNormalizedString(value);

  if (
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high"
  ) {
    return normalized;
  }

  return "unknown";
}

function normalizeUrgency(
  value: unknown
): "unknown" | "low" | "medium" | "high" {
  const normalized = toNormalizedString(value);

  if (
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high"
  ) {
    return normalized;
  }

  return "unknown";
}

function getCommercialSignal(
  input: FastpathReplyPolicyInput
): FastpathReplyPolicy["commercialPolicy"] {
  const raw =
    input.detectedCommercial ??
    input.ctxPatch?.commercialSignal ??
    input.fp?.ctxPatch?.commercialSignal ??
    null;

  const purchaseIntent = normalizePurchaseIntent(raw?.purchaseIntent);
  const urgency = normalizeUrgency(raw?.urgency);
  const wantsBooking = raw?.wantsBooking === true;
  const wantsQuote = raw?.wantsQuote === true;
  const wantsHuman = raw?.wantsHuman === true;

  const shouldUseSalesTone =
    purchaseIntent === "medium" ||
    purchaseIntent === "high" ||
    wantsBooking ||
    wantsQuote;

  const shouldUseDirectClosing =
    purchaseIntent === "high" ||
    urgency === "high" ||
    wantsBooking;

  const shouldUseSoftClosing =
    !shouldUseDirectClosing &&
    (purchaseIntent === "medium" || wantsQuote);

  const shouldSuggestHumanHandoff =
    wantsHuman === true &&
    purchaseIntent !== "low";

  return {
    purchaseIntent,
    wantsBooking,
    wantsQuote,
    wantsHuman,
    urgency,
    shouldUseSalesTone,
    shouldUseSoftClosing,
    shouldUseDirectClosing,
    shouldSuggestHumanHandoff,
  };
}

export function buildFastpathReplyPolicy(
  input: FastpathReplyPolicyInput
): FastpathReplyPolicy {
  const isDmChannel = isDmChatChannel(input.canal);

  const fpSource = String(input.fp?.source || "").trim();
  const fpIntent = String(
    input.fp?.intent || input.detectedIntent || input.intentFallback || ""
  ).trim();

  const hasResolvedEntity = Boolean(input.structuredService?.hasResolution);
  const replySourceKind = getReplySourceKind({
    fpSource,
    structuredService: input.structuredService,
    catalogReferenceClassification: input.catalogReferenceClassification,
    catalogRoutingSignal: input.catalogRoutingSignal,
  });

  const commercialPolicy = getCommercialSignal(input);

  const isVariantDisambiguation = isVariantDisambiguationState({
    fp: input.fp,
    ctxPatch: input.ctxPatch,
    structuredService: input.structuredService,
  });

  const isServiceChoiceDisambiguation = isServiceChoiceDisambiguationState({
    fp: input.fp,
    catalogRoutingSignal: input.catalogRoutingSignal,
    structuredService: input.structuredService,
  });

  const canonicalBodyOwnsClosing =
    isVariantDisambiguation ||
    isServiceChoiceDisambiguation ||
    input.fp?.awaitingEffect?.type === "set_awaiting_yes_no";

  const shouldBypassStructuredRewrite =
    isDmChannel && hasPendingLinkState(input.ctxPatch);

  const shouldPersistStructuredService =
    hasResolvedEntity &&
    !isVariantDisambiguation &&
    toNormalizedString(input.catalogRoutingSignal?.routeIntent) !==
      "catalog_compare" &&
    fpSource !== "catalog_db" &&
    fpSource !== "price_disambiguation_db" &&
    fpSource !== "catalog_disambiguation_db" &&
    fpIntent !== "info_general";

  const shouldHardBypassReply = false;
  const shouldDirectReturnInfoBlock = false;
  const shouldDirectReturnPriceLikeReply = false;

  const isCatalogDbReply = replySourceKind === "catalog_grounded";
  const isPriceSummaryReply =
    fpSource === "price_summary_db" || fpSource === "price_missing_db";
  const isPriceDisambiguationReply =
    replySourceKind === "catalog_disambiguation" ||
    isServiceChoiceDisambiguation;

  const isGroundedCatalogReply =
    isCatalogDbReply ||
    isPriceSummaryReply ||
    isPriceDisambiguationReply;

  const isGroundedCatalogOverviewDm =
    isDmChannel &&
    isGroundedCatalogReply &&
    !hasResolvedEntity;

  const shouldForceSalesClosingQuestion =
    isGroundedCatalogOverviewDm &&
    commercialPolicy.shouldUseSalesTone &&
    !input.ctxPatch?.pending_cta &&
    !input.fp?.awaitingEffect;

  const shouldUseGroundedFrameOnly =
    isVariantDisambiguation ||
    replySourceKind === "catalog_grounded" ||
    replySourceKind === "business_info" ||
    replySourceKind === "price_like" ||
    replySourceKind === "catalog_comparison_render";

  const responsePolicyMode: FastpathReplyPolicy["responsePolicyMode"] =
    isServiceChoiceDisambiguation
      ? "clarify_only"
      : shouldUseGroundedFrameOnly
      ? "grounded_frame_only"
      : hasResolvedEntity
      ? "grounded_only"
      : "clarify_only";

  const shouldRunDmRewrite =
    isDmChannel &&
    !shouldBypassStructuredRewrite &&
    !canonicalBodyOwnsClosing;

  return {
    isDmChannel,
    shouldBypassStructuredRewrite,
    shouldPersistStructuredService,
    shouldHardBypassReply,
    shouldDirectReturnInfoBlock,
    shouldDirectReturnPriceLikeReply,
    shouldRunDmRewrite,
    shouldUseGroundedFrameOnly,
    hasResolvedEntity,

    isCatalogDbReply,
    isPriceSummaryReply,
    isPriceDisambiguationReply,
    isGroundedCatalogReply,
    isGroundedCatalogOverviewDm,
    shouldForceSalesClosingQuestion,

    replySourceKind,
    responsePolicyMode,

    canonicalBodyOwnsClosing,
    commercialPolicy,
  };
}