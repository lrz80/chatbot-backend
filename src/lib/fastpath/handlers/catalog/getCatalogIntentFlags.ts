//src/lib/fastpath/handlers/catalog/getCatalogIntentFlags.ts
type CatalogFacets = {
  asksPrices?: boolean;
  asksSchedules?: boolean;
  asksLocation?: boolean;
  asksAvailability?: boolean;
};

type GetCatalogIntentFlagsInput = {
  routeIntent?: string | null;
  facets?: CatalogFacets | null;
};

export type CatalogIntentFlags = {
  isCombinationIntent: boolean;
  asksIncludesOnly: boolean;
  isAskingOtherCatalogOptions: boolean;
  asksSchedules: boolean;
  asksPrices: boolean;
  asksLocation: boolean;
  asksAvailability: boolean;
};

export function getCatalogIntentFlags(
  input: GetCatalogIntentFlagsInput
): CatalogIntentFlags {
  const routeIntent = String(input.routeIntent || "").trim().toLowerCase();

  const facets: CatalogFacets = input.facets ?? {};

  const isCombinationIntent = routeIntent === "catalog_combination";

  const asksSchedules =
    Boolean(facets.asksSchedules) || routeIntent === "catalog_schedule";

  const asksPrices = Boolean(facets.asksPrices);

  const asksLocation = Boolean(facets.asksLocation);

  const asksAvailability = Boolean(facets.asksAvailability);

  const asksIncludesOnly =
    !asksSchedules &&
    !asksLocation &&
    !asksAvailability &&
    (
      routeIntent === "catalog_includes" ||
      routeIntent === "entity_detail" ||
      routeIntent === "variant_detail"
    );

  const isAskingOtherCatalogOptions = routeIntent === "catalog_alternatives";

  return {
    isCombinationIntent,
    asksIncludesOnly,
    isAskingOtherCatalogOptions,
    asksSchedules,
    asksPrices,
    asksLocation,
    asksAvailability,
  };
}