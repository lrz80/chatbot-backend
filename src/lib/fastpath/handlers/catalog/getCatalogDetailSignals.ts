type GetCatalogDetailSignalsInput = {
  detectedIntent?: string | null;
  catalogReferenceClassification?: any;
  convoCtx: any;
  targetServiceId?: string | null;
  targetVariantId?: string | null;
  targetFamilyKey?: string | null;
};

export type CatalogDetailSignals = {
  detectedIntentNorm: string;
  classifiedIntentNorm: string;
  referenceKind: string;
  looksLikeExplicitDetail: boolean;
  looksLikeEllipticDetail: boolean;
  looksLikeServiceDetail: boolean;
  recentPriceContext: boolean;
  looksLikeEllipticPriceFollowup: boolean;
};

export function getCatalogDetailSignals(
  input: GetCatalogDetailSignalsInput
): CatalogDetailSignals {
  const detectedIntentNorm = String(
    input.detectedIntent || ""
  ).trim().toLowerCase();

  const classifiedIntentNorm = String(
    input.catalogReferenceClassification?.intent || ""
  ).trim().toLowerCase();

  const referenceKind = String(
    input.catalogReferenceClassification?.kind || "none"
  ).trim().toLowerCase();

  const looksLikeExplicitDetail =
    classifiedIntentNorm === "includes" ||
    detectedIntentNorm === "info_servicio";

  const looksLikeEllipticDetail =
    referenceKind === "referential_followup" &&
    (
      classifiedIntentNorm === "includes" ||
      detectedIntentNorm === "info_servicio" ||
      Boolean(
        input.targetServiceId ||
        input.targetVariantId ||
        input.targetFamilyKey
      )
    );

  const looksLikeServiceDetail =
    looksLikeExplicitDetail || looksLikeEllipticDetail;

  const recentPriceContext =
    String((input.convoCtx as any)?.last_bot_action || "") ===
      "followup_set_service_for_price" ||
    Boolean((input.convoCtx as any)?.last_price_option_label) ||
    Boolean((input.convoCtx as any)?.last_variant_id) ||
    detectedIntentNorm === "precio" ||
    classifiedIntentNorm === "price_or_plan";

  const looksLikeEllipticPriceFollowup =
    recentPriceContext &&
    referenceKind === "referential_followup" &&
    classifiedIntentNorm !== "includes";

  return {
    detectedIntentNorm,
    classifiedIntentNorm,
    referenceKind,
    looksLikeExplicitDetail,
    looksLikeEllipticDetail,
    looksLikeServiceDetail,
    recentPriceContext,
    looksLikeEllipticPriceFollowup,
  };
}