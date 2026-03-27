import type { Canal } from "../../../detectarIntencion";

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

function getReplySourceKind(params: {
  fpSource: string;
  structuredService: StructuredServiceSelection;
  catalogReferenceClassification?: any;
  catalogRoutingSignal?: any;
}): FastpathReplyPolicy["replySourceKind"] {
  const fpSource = params.fpSource;
  const hasResolvedEntity = Boolean(params.structuredService?.hasResolution);

  if (fpSource === "catalog_comparison_db_llm_render") {
    return "catalog_comparison_render";
  }

  if (fpSource === "price_disambiguation_db") {
    return "catalog_disambiguation";
  }

  if (fpSource.startsWith("info_clave")) {
    return "business_info";
  }

  if (
    fpSource === "price_fastpath_db_llm_render" ||
    fpSource === "price_fastpath_db_no_price_llm_render" ||
    fpSource === "price_fastpath_db" ||
    fpSource === "price_summary_db" ||
    fpSource === "price_summary_db_llm_render" ||
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

  if (
    params.catalogReferenceClassification?.kind === "comparison" ||
    params.catalogRoutingSignal?.routeIntent === "catalog_compare"
  ) {
    return "catalog_comparison_render";
  }

  return "generic";
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

  const shouldBypassStructuredRewrite =
    isDmChannel && hasPendingLinkState(input.ctxPatch);

  const shouldPersistStructuredService =
    hasResolvedEntity &&
    input.catalogReferenceClassification?.kind !== "comparison" &&
    fpSource !== "catalog_db" &&
    fpSource !== "price_disambiguation_db" &&
    fpIntent !== "info_general";

  const shouldHardBypassReply =
    isDmChannel &&
    (
      replySourceKind === "catalog_comparison_render" ||
      replySourceKind === "business_info"
    );

  const shouldDirectReturnInfoBlock =
    isDmChannel && replySourceKind === "business_info";

  const shouldDirectReturnPriceLikeReply =
    isDmChannel &&
    replySourceKind === "price_like" &&
    (
      input.catalogRoutingSignal?.routeIntent === "catalog_price" ||
      input.catalogRoutingSignal?.routeIntent === "catalog_alternatives" ||
      input.catalogRoutingSignal?.routeIntent === "catalog_schedule" ||
      input.catalogReferenceClassification?.kind === "comparison" ||
      input.catalogReferenceClassification?.intent === "includes"
    );

  const shouldUseGroundedFrameOnly =
    replySourceKind === "catalog_grounded" ||
    replySourceKind === "catalog_disambiguation";

  const responsePolicyMode: FastpathReplyPolicy["responsePolicyMode"] =
    shouldUseGroundedFrameOnly
      ? "grounded_frame_only"
      : hasResolvedEntity
      ? "grounded_only"
      : "clarify_only";

  const shouldRunDmRewrite =
    isDmChannel &&
    !shouldBypassStructuredRewrite &&
    !shouldHardBypassReply &&
    !shouldDirectReturnInfoBlock &&
    !shouldDirectReturnPriceLikeReply;

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
    replySourceKind,
    responsePolicyMode,
  };
}