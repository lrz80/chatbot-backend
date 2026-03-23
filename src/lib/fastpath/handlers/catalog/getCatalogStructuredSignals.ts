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

function allowsContextCarryover(referenceKind: string): boolean {
  return (
    referenceKind === "referential_followup" ||
    referenceKind === "entity_specific" ||
    referenceKind === "variant_specific" ||
    referenceKind === "catalog_family"
  );
}

export function getCatalogStructuredSignals(
  input: CatalogStructuredSignalsInput
): CatalogStructuredSignals {
  const referenceKind = String(
    input.catalogReferenceClassification?.kind || "none"
  )
    .trim()
    .toLowerCase();

  const useContextCarryover = allowsContextCarryover(referenceKind);

  const targetServiceId =
    input.catalogReferenceClassification?.targetServiceId ||
    (useContextCarryover
      ? input.convoCtx?.last_service_id || input.convoCtx?.selectedServiceId
      : null) ||
    null;

  const targetVariantId =
    input.catalogReferenceClassification?.targetVariantId ||
    (useContextCarryover ? input.convoCtx?.last_variant_id : null) ||
    null;

  const targetFamilyKey =
    input.catalogReferenceClassification?.targetFamilyKey ||
    (useContextCarryover ? input.convoCtx?.last_family_key : null) ||
    null;

  const hasStructuredTarget =
    Boolean(targetServiceId || targetVariantId || targetFamilyKey) ||
    referenceKind === "referential_followup" ||
    referenceKind === "entity_specific" ||
    referenceKind === "variant_specific" ||
    referenceKind === "catalog_family";

  const shouldResolveFromStructuredTarget =
    useContextCarryover && Boolean(targetServiceId);

  return {
    referenceKind,
    targetServiceId,
    targetVariantId,
    targetFamilyKey,
    hasStructuredTarget,
    shouldResolveFromStructuredTarget,
  };
}