//src/lib/channels/engine/fastpath/getFastpathPostRunDecision.ts
import type { Canal } from "../../../detectarIntencion";

export type GetFastpathPostRunDecisionInput = {
  canal: Canal;
  fp: {
    source?: string | null;
    intent?: string | null;
    reply?: string | null;
  };
  detectedIntent?: string | null;
  intentFallback?: string | null;
  convoCtx?: any;
  catalogRoutingSignal?: any;
  catalogReferenceClassification?: any;
  structuredService: {
    hasResolution: boolean;
  };
};

export type GetFastpathPostRunDecisionResult = {
  isDmChannel: boolean;
  shouldReturnRawFastpathForPriceQuestion: boolean;
  shouldNaturalizeSecondaryOptions: boolean;
  shouldReturnRawFastpathForUnresolvedServiceIntent: boolean;
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

function isGroundedServiceSource(fpSource: string): boolean {
  return (
    fpSource === "service_list_db" ||
    fpSource === "catalog_db" ||
    fpSource === "price_summary_db" ||
    fpSource === "price_fastpath_db" ||
    fpSource === "price_disambiguation_db" ||
    fpSource === "price_fastpath_db_no_price"
  );
}

export function getFastpathPostRunDecision(
  input: GetFastpathPostRunDecisionInput
): GetFastpathPostRunDecisionResult {
  const isDmChannel = isDmChatChannel(input.canal);

  const fpSource = toNormalizedString(input.fp?.source);
  const fpIntent = toNormalizedString(
    input.fp?.intent || input.detectedIntent || input.intentFallback || ""
  );

  const routeIntent = toNormalizedString(
    input.catalogRoutingSignal?.routeIntent
  );

  const isPriceQuestionUser =
    routeIntent === "catalog_price" ||
    routeIntent === "catalog_alternatives";

  const wantsPlansAndHours = routeIntent === "catalog_schedule";

  const isCatalogDetailQuestion =
    routeIntent === "catalog_includes" ||
    fpIntent === "info_servicio";

  const shouldReturnRawFastpathForPriceQuestion =
    isDmChannel &&
    isPriceQuestionUser &&
    !wantsPlansAndHours &&
    !isCatalogDetailQuestion &&
    fpSource !== "catalog_db" &&
    fpSource !== "price_fastpath_db_llm_render" &&
    fpSource !== "price_fastpath_db_no_price_llm_render";

  const isPlansList =
    toNormalizedString(input.fp?.source) === "service_list_db" &&
    (input.convoCtx as any)?.last_list_kind === "plan";

  const hasPackagesAvailable =
    (input.convoCtx as any)?.has_packages_available === true;

  const shouldNaturalizeSecondaryOptions =
    toNormalizedString(input.canal) !== "whatsapp" &&
    isPlansList &&
    hasPackagesAvailable;

  const isPluralCatalogTurn =
    routeIntent === "catalog_overview" ||
    routeIntent === "catalog_family" ||
    routeIntent === "catalog_compare" ||
    routeIntent === "catalog_price" ||
    routeIntent === "catalog_alternatives" ||
    routeIntent === "catalog_schedule";

  const isExplicitServiceDetailTurn =
    routeIntent === "catalog_includes" ||
    routeIntent === "entity_detail" ||
    routeIntent === "variant_detail" ||
    fpIntent === "info_servicio";

  const shouldReturnRawFastpathForUnresolvedServiceIntent =
    isDmChannel &&
    !isPluralCatalogTurn &&
    isExplicitServiceDetailTurn &&
    (
      !input.structuredService?.hasResolution ||
      !isGroundedServiceSource(fpSource)
    );

  return {
    isDmChannel,
    shouldReturnRawFastpathForPriceQuestion,
    shouldNaturalizeSecondaryOptions,
    shouldReturnRawFastpathForUnresolvedServiceIntent,
  };
}