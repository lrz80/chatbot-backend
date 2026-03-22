export type CatalogStructuredSignalsInput = {
  catalogReferenceClassification?: any;
  convoCtx: any;
};

export type CatalogStructuredSignals = {
  referenceKind: string;
  targetServiceId: string | null;
  targetVariantId: string | null;
  targetFamilyKey: string | null;
  hasStructuredTarget: boolean;
  shouldResolveFromStructuredTarget: boolean;
};

export function getCatalogStructuredSignals(
  input: CatalogStructuredSignalsInput
): CatalogStructuredSignals {
  const referenceKind = String(
    input.catalogReferenceClassification?.kind || "none"
  ).trim().toLowerCase();

  const targetServiceId =
    input.catalogReferenceClassification?.targetServiceId ||
    input.convoCtx?.last_service_id ||
    input.convoCtx?.selectedServiceId ||
    null;

  const targetVariantId =
    input.catalogReferenceClassification?.targetVariantId ||
    input.convoCtx?.last_variant_id ||
    null;

  const targetFamilyKey =
    input.catalogReferenceClassification?.targetFamilyKey ||
    input.convoCtx?.last_family_key ||
    null;

  const hasStructuredTarget =
    Boolean(targetServiceId || targetVariantId || targetFamilyKey) ||
    referenceKind === "referential_followup" ||
    referenceKind === "entity_specific" ||
    referenceKind === "variant_specific" ||
    referenceKind === "catalog_family";

  const shouldResolveFromStructuredTarget = Boolean(targetServiceId);

  return {
    referenceKind,
    targetServiceId,
    targetVariantId,
    targetFamilyKey,
    hasStructuredTarget,
    shouldResolveFromStructuredTarget,
  };
}