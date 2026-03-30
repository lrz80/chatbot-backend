type GetCatalogRoutingStateInput = {
  detectedIntent?: string | null;
  isStructuredCatalogTurn: boolean;
  catalogReferenceClassification?: any;
  convoCtx: any;
  buildCatalogRoutingSignal: (input: {
    intentOut: string | null;
    catalogReferenceClassification?: any;
    convoCtx: any;
  }) => any;
};

export type CatalogRoutingState = {
  catalogIntentNorm: string;
  catalogRoutingSignal: any;
  catalogRouteIntent: string;
  isFreshCatalogPriceTurn: boolean;
};

function shouldDropCatalogAnchorsForTurn(input: {
  detectedIntent?: string | null;
  catalogReferenceClassification?: any;
}): boolean {
  const detectedIntentNorm = String(input.detectedIntent || "")
    .trim()
    .toLowerCase();

  const classification = input.catalogReferenceClassification || {};
  const signals = classification?.signals || {};

  const hasExplicitTargetThisTurn =
    Boolean(classification?.targetServiceId) ||
    Boolean(classification?.targetVariantId) ||
    Boolean(classification?.targetFamilyKey) ||
    classification?.kind === "entity_specific" ||
    classification?.kind === "variant_specific" ||
    classification?.kind === "catalog_family" ||
    classification?.kind === "referential_followup";

  const isScheduleAvailabilityTurn =
    detectedIntentNorm === "disponibilidad" ||
    detectedIntentNorm === "info_horarios_generales" ||
    Boolean(signals?.asksSchedules) ||
    Boolean(signals?.asksAvailability);

  return isScheduleAvailabilityTurn && !hasExplicitTargetThisTurn;
}

function buildRoutingContext(convoCtx: any, dropAnchors: boolean): any {
  const base = convoCtx && typeof convoCtx === "object" ? convoCtx : {};

  if (!dropAnchors) {
    return base;
  }

  return {
    ...base,

    selectedServiceId: null,
    last_service_id: null,
    last_service_name: null,
    last_variant_id: null,
    last_variant_name: null,
    last_variant_url: null,

    lastEntityId: null,
    lastEntityName: null,
    lastFamilyKey: null,
    lastFamilyName: null,

    last_catalog_plans: [],
    lastPresentedEntityIds: [],
    lastPresentedFamilyKeys: [],
    previousCatalogPlans: [],

    structuredService: null,
  };
}

export function getCatalogRoutingState(
  input: GetCatalogRoutingStateInput
): CatalogRoutingState {
  const catalogIntentNorm = String(
    input.detectedIntent || ""
  ).trim().toLowerCase();

  const dropAnchors = shouldDropCatalogAnchorsForTurn({
    detectedIntent: input.detectedIntent,
    catalogReferenceClassification: input.catalogReferenceClassification,
  });

  const routingConvoCtx = buildRoutingContext(input.convoCtx, dropAnchors);

  const catalogRoutingSignal = input.buildCatalogRoutingSignal({
    intentOut: input.detectedIntent || null,
    catalogReferenceClassification: input.catalogReferenceClassification,
    convoCtx: routingConvoCtx,
  });

  const catalogRouteIntent = String(
    catalogRoutingSignal?.routeIntent || ""
  ).trim();

  const isFreshCatalogPriceTurn =
    catalogRouteIntent === "catalog_price" ||
    catalogRouteIntent === "catalog_schedule" ||
    catalogRouteIntent === "catalog_alternatives" ||
    (
      catalogIntentNorm === "precio" &&
      input.isStructuredCatalogTurn
    );

  return {
    catalogIntentNorm,
    catalogRoutingSignal,
    catalogRouteIntent,
    isFreshCatalogPriceTurn,
  };
}