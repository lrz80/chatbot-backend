import type { FastpathResult } from "../../../../lib/fastpath/runFastpath";

type CatalogFacets = {
  asksPrices?: boolean;
  asksSchedules?: boolean;
  asksLocation?: boolean;
  asksAvailability?: boolean;
};

type FastpathResolvedShape = {
  intent?: string | null;
  source?: string | null;
};

type ResolveFinalIntentFromTurnInput = {
  detectedIntent?: string | null;
  intentFallback?: string | null;
  fp?: FastpathResolvedShape | null;
  facets?: CatalogFacets | null;
  catalogRoutingSignal?: {
    routeIntent?: string | null;
    targetLevel?: string | null;
  } | null;
  catalogReferenceClassification?: {
    intent?: string | null;
    kind?: string | null;
  } | null;
};

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function hasText(value: unknown): boolean {
  return normalize(value).length > 0;
}

export function resolveFinalIntentFromTurn(
  input: ResolveFinalIntentFromTurnInput
): string {
  const detectedIntent = normalize(input.detectedIntent);
  const intentFallback = normalize(input.intentFallback);

  const fpIntent = normalize(input.fp?.intent);
  const fpSource = normalize(input.fp?.source);

  const asksPrices = Boolean(input.facets?.asksPrices);
  const asksSchedules = Boolean(input.facets?.asksSchedules);
  const asksLocation = Boolean(input.facets?.asksLocation);
  const asksAvailability = Boolean(input.facets?.asksAvailability);

  const routeIntent = normalize(input.catalogRoutingSignal?.routeIntent);
  const classificationIntent = normalize(
    input.catalogReferenceClassification?.intent
  );
  const classificationKind = normalize(
    input.catalogReferenceClassification?.kind
  );
  const targetLevel = normalize(input.catalogRoutingSignal?.targetLevel);

  if (hasText(fpIntent)) {
    return fpIntent;
  }

  if (
    routeIntent === "catalog_price" ||
    routeIntent === "catalog_alternatives" ||
    classificationIntent === "price_or_plan"
  ) {
    return "precio";
  }

  if (
    fpSource === "price_summary_db" ||
    fpSource === "price_fastpath_db" ||
    fpSource === "price_disambiguation_db" ||
    fpSource === "price_fastpath_db_no_price"
  ) {
    return "precio";
  }

  if (routeIntent === "catalog_schedule" || asksSchedules) {
    return "horario";
  }

  if (asksLocation) {
    return "ubicacion";
  }

  if (asksAvailability) {
    return "disponibilidad";
  }

  if (
    routeIntent === "catalog_includes" ||
    classificationIntent === "includes" ||
    classificationKind === "entity_specific" ||
    classificationKind === "variant_specific" ||
    classificationKind === "referential_followup" ||
    targetLevel === "service" ||
    targetLevel === "variant"
  ) {
    return "info_servicio";
  }

  if (
    classificationKind === "catalog_overview" ||
    classificationKind === "catalog_family" ||
    targetLevel === "catalog" ||
    targetLevel === "family" ||
    targetLevel === "multi_service"
  ) {
    if (asksPrices) return "precio";
    return "catalogo";
  }

  if (asksPrices) return "precio";
  if (asksSchedules) return "horario";
  if (asksLocation) return "ubicacion";
  if (asksAvailability) return "disponibilidad";

  return detectedIntent || intentFallback || "duda";
}