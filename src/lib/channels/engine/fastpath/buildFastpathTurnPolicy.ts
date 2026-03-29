export type IntentFacets = {
  asksPrices?: boolean;
  asksSchedules?: boolean;
  asksLocation?: boolean;
  asksAvailability?: boolean;
};

export type FastpathTurnPolicyInput = {
  classification: any;
  facets?: IntentFacets | null;
  structuredComparison?: any;
  convoCtx?: any;
  referentialFollowup?: boolean;
  followupNeedsAnchor?: boolean;
};

export type FastpathTurnPolicy = {
  shouldRouteCatalog: boolean;
  shouldBuildComparison: boolean;
  canReuseCatalogContext: boolean;
  shouldUseRoutingStructuredService: boolean;
  shouldAllowExplicitEntityPromotion: boolean;
  shouldAllowLooseResolution: boolean;
};

function hasCatalogAnchorInContext(convoCtx: any): boolean {
  return Boolean(
    String(convoCtx?.last_service_id || "").trim() ||
      String(convoCtx?.selectedServiceId || "").trim() ||
      String(convoCtx?.selected_service_id || "").trim() ||
      (Array.isArray(convoCtx?.lastPresentedEntityIds) &&
        convoCtx.lastPresentedEntityIds.length > 0) ||
      (Array.isArray(convoCtx?.last_presented_entity_ids) &&
        convoCtx.last_presented_entity_ids.length > 0)
  );
}

export function buildFastpathTurnPolicy(
  input: FastpathTurnPolicyInput
): FastpathTurnPolicy {
  const classification = input.classification || {};
  const signals = classification?.signals || {};
  const facets = input.facets || {};

  const hasExplicitTarget =
    Boolean(classification?.targetServiceId) ||
    Boolean(classification?.targetVariantId) ||
    Boolean(classification?.targetFamilyKey);

  const hasEntityReference =
    classification?.kind === "entity_specific" ||
    classification?.kind === "variant_specific" ||
    classification?.kind === "catalog_family" ||
    classification?.kind === "referential_followup";

  const hasComparison =
    classification?.kind === "comparison" ||
    Boolean(input.structuredComparison?.hasComparison);

  const hasConversationDependency =
    Boolean(signals?.hasReferentialDependency) ||
    Boolean(signals?.hasConversationDependency) ||
    Boolean(input.referentialFollowup) ||
    Boolean(input.followupNeedsAnchor) ||
    hasCatalogAnchorInContext(input.convoCtx);

  const hasCatalogNeed =
    hasExplicitTarget ||
    hasEntityReference ||
    hasComparison ||
    Boolean(facets?.asksPrices);

  const shouldRouteCatalog = hasCatalogNeed || hasConversationDependency;

  const shouldBuildComparison =
    hasComparison ||
    (
        shouldRouteCatalog &&
        !hasExplicitTarget &&
        classification?.kind !== "variant_specific"
    );

  const canReuseCatalogContext =
    hasExplicitTarget ||
    hasEntityReference ||
    hasComparison ||
    Boolean(facets?.asksPrices) ||
    Boolean(signals?.hasReferentialDependency);

  const shouldUseRoutingStructuredService =
    Boolean(classification?.targetServiceId) &&
    (
      classification?.targetLevel === "service" ||
      classification?.targetLevel === "variant"
    );

  const shouldAllowExplicitEntityPromotion =
    !shouldBuildComparison &&
    (
        hasConversationDependency ||
        hasExplicitTarget ||
        Boolean(facets?.asksPrices)
    );

  const shouldAllowLooseResolution =
    shouldRouteCatalog || Boolean(facets?.asksPrices);

  return {
    shouldRouteCatalog,
    shouldBuildComparison,
    canReuseCatalogContext,
    shouldUseRoutingStructuredService,
    shouldAllowExplicitEntityPromotion,
    shouldAllowLooseResolution,
  };
}