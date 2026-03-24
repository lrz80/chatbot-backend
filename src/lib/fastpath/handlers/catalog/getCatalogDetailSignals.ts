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

function normalizeSignal(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function isIncludesIntent(value: string): boolean {
  return value === "includes";
}

function isServiceDetailIntent(value: string): boolean {
  return value === "info_servicio";
}

function isPriceIntent(value: string): boolean {
  return value === "precio";
}

function isPriceOrPlanIntent(value: string): boolean {
  return value === "price_or_plan";
}

function isReferentialFollowupKind(value: string): boolean {
  return value === "referential_followup";
}

function hasStructuredTarget(input: GetCatalogDetailSignalsInput): boolean {
  return Boolean(
    input.targetServiceId || input.targetVariantId || input.targetFamilyKey
  );
}

function hasRecentPriceState(convoCtx: any): boolean {
  return (
    normalizeSignal(convoCtx?.last_bot_action) ===
      "followup_set_service_for_price" ||
    Boolean(convoCtx?.last_price_option_label) ||
    Boolean(convoCtx?.last_variant_id)
  );
}

export function getCatalogDetailSignals(
  input: GetCatalogDetailSignalsInput
): CatalogDetailSignals {
  const detectedIntentNorm = normalizeSignal(input.detectedIntent);

  const classifiedIntentNorm = normalizeSignal(
    input.catalogReferenceClassification?.intent
  );

  const referenceKind = normalizeSignal(
    input.catalogReferenceClassification?.kind || "none"
  );

  const looksLikeExplicitDetail =
    isIncludesIntent(classifiedIntentNorm) ||
    isServiceDetailIntent(detectedIntentNorm);

  const looksLikeEllipticDetail =
    isReferentialFollowupKind(referenceKind) &&
    (
      isIncludesIntent(classifiedIntentNorm) ||
      isServiceDetailIntent(detectedIntentNorm) ||
      hasStructuredTarget(input)
    );

  const looksLikeServiceDetail =
    looksLikeExplicitDetail || looksLikeEllipticDetail;

  const recentPriceContext =
    hasRecentPriceState(input.convoCtx) ||
    (
      isReferentialFollowupKind(referenceKind) &&
      (isPriceIntent(detectedIntentNorm) || isPriceOrPlanIntent(classifiedIntentNorm))
    );

  const looksLikeEllipticPriceFollowup =
    recentPriceContext &&
    isReferentialFollowupKind(referenceKind) &&
    !isIncludesIntent(classifiedIntentNorm);

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