type GetCatalogIntentFlagsInput = {
  routeIntent?: string | null;
};

export type CatalogIntentFlags = {
  isCombinationIntent: boolean;
  asksIncludesOnly: boolean;
  isAskingOtherCatalogOptions: boolean;
  asksSchedules: boolean;
};

export function getCatalogIntentFlags(
  input: GetCatalogIntentFlagsInput
): CatalogIntentFlags {
  const routeIntent = String(input.routeIntent || "").trim().toLowerCase();

  const isCombinationIntent =
    routeIntent === "catalog_combination";

  const asksIncludesOnly =
    routeIntent === "catalog_includes" ||
    routeIntent === "entity_detail" ||
    routeIntent === "variant_detail";

  const isAskingOtherCatalogOptions =
    routeIntent === "catalog_alternatives";

  const asksSchedules =
    routeIntent === "catalog_schedule";

  return {
    isCombinationIntent,
    asksIncludesOnly,
    isAskingOtherCatalogOptions,
    asksSchedules,
  };
}