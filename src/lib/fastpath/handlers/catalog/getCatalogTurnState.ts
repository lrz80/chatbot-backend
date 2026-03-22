type GetCatalogTurnStateInput = {
  catalogRoutingSignal: any;
  convoCtx: any;
  hasStructuredTarget: boolean;
};

export type CatalogTurnState = {
  hasRecentCatalogContext: boolean;
  intentAllowsCatalogRouting: boolean;
  isCatalogPriceLikeTurn: boolean;
  hasStructuredCatalogState: boolean;
  isCatalogQuestion: boolean;
};

export function getCatalogTurnState(
  input: GetCatalogTurnStateInput
): CatalogTurnState {
  const hasRecentCatalogContext =
    Boolean(input.catalogRoutingSignal?.hasFreshCatalogContext) ||
    (Array.isArray((input.convoCtx as any)?.last_plan_list) &&
      (input.convoCtx as any).last_plan_list.length > 0) ||
    (Array.isArray((input.convoCtx as any)?.last_package_list) &&
      (input.convoCtx as any).last_package_list.length > 0) ||
    (Array.isArray((input.convoCtx as any)?.pending_link_options) &&
      (input.convoCtx as any).pending_link_options.length > 0) ||
    Boolean((input.convoCtx as any)?.pending_link_lookup) ||
    Boolean((input.convoCtx as any)?.expectingVariant);

  const intentAllowsCatalogRouting = Boolean(
    input.catalogRoutingSignal?.allowsDbCatalogPath
  );

  const isCatalogPriceLikeTurn =
    input.catalogRoutingSignal?.routeIntent === "catalog_price" ||
    input.catalogRoutingSignal?.routeIntent === "catalog_schedule" ||
    input.catalogRoutingSignal?.routeIntent === "catalog_alternatives";

  const hasStructuredCatalogState =
    hasRecentCatalogContext ||
    (
      (intentAllowsCatalogRouting || isCatalogPriceLikeTurn) &&
      (
        Boolean((input.convoCtx as any)?.selectedServiceId) ||
        Boolean((input.convoCtx as any)?.last_service_id)
      )
    );

  const isCatalogQuestion =
    Boolean(input.catalogRoutingSignal?.shouldRouteCatalog) ||
    isCatalogPriceLikeTurn ||
    hasStructuredCatalogState ||
    input.hasStructuredTarget;

  return {
    hasRecentCatalogContext,
    intentAllowsCatalogRouting,
    isCatalogPriceLikeTurn,
    hasStructuredCatalogState,
    isCatalogQuestion,
  };
}