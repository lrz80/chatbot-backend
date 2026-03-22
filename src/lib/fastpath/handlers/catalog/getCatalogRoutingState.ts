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

export function getCatalogRoutingState(
  input: GetCatalogRoutingStateInput
): CatalogRoutingState {
  const catalogIntentNorm = String(
    input.detectedIntent || ""
  ).trim().toLowerCase();

  const catalogRoutingSignal = input.buildCatalogRoutingSignal({
    intentOut: input.detectedIntent || null,
    catalogReferenceClassification: input.catalogReferenceClassification,
    convoCtx: input.convoCtx,
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