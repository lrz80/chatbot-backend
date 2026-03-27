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
    fpSource === "price_disambiguation_db"
  );
}

export function getFastpathPostRunDecision(
  input: GetFastpathPostRunDecisionInput
): GetFastpathPostRunDecisionResult {
  const isDmChannel = isDmChatChannel(input.canal);

  const fpSource = String(input.fp?.source || "").trim();
  const fpIntent = String(
    input.fp?.intent || input.detectedIntent || input.intentFallback || ""
  ).trim();

  const routeIntent = String(input.catalogRoutingSignal?.routeIntent || "").trim();
  const classificationIntent = String(
    input.catalogReferenceClassification?.intent || ""
  ).trim();

  const isPriceQuestionUser =
    routeIntent === "catalog_price" ||
    routeIntent === "catalog_alternatives";

  const wantsPlansAndHours = routeIntent === "catalog_schedule";

  const isCatalogDetailQuestion =
    routeIntent === "catalog_includes" ||
    classificationIntent === "includes";

  const shouldReturnRawFastpathForPriceQuestion =
    isDmChannel &&
    isPriceQuestionUser &&
    !wantsPlansAndHours &&
    !isCatalogDetailQuestion &&
    fpSource !== "catalog_db" &&
    fpSource !== "price_fastpath_db_llm_render" &&
    fpSource !== "price_fastpath_db_no_price_llm_render";

  const isPlansList =
    fpSource === "service_list_db" &&
    (input.convoCtx as any)?.last_list_kind === "plan";

  const hasPackagesAvailable =
    (input.convoCtx as any)?.has_packages_available === true;

  const shouldNaturalizeSecondaryOptions =
    String(input.canal || "").trim().toLowerCase() !== "whatsapp" &&
    isPlansList &&
    hasPackagesAvailable;

  const shouldReturnRawFastpathForUnresolvedServiceIntent =
    isDmChannel &&
    fpIntent === "info_servicio" &&
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